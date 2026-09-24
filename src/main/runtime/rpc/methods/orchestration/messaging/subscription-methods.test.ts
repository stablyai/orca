import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SUBSCRIPTION_METHODS } from './subscription-methods'
import { TerminalSubscriptionParams } from '../../../../../../shared/rpc-contract/terminal-subscription-params'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { TerminalMailboxSubscriptionStatus } from '../../../../../../shared/terminal-mailbox-subscription'

function status(subscribed: boolean): TerminalMailboxSubscriptionStatus {
  return {
    subscribed,
    state: subscribed ? 'active' : 'unsubscribed',
    wake: subscribed ? 'deferred' : 'unsupported',
    reason: subscribed ? 'awaiting_mail_or_idle' : 'explicit_unsubscribe',
    messageIds: [],
    createdAt: subscribed ? '2026-09-21T00:00:00.000Z' : null,
    submitPolicy: 'recognized_non_cursor'
  }
}

describe('subscription RPC identity boundary', () => {
  it('rejects arbitrary target parameters', () => {
    expect(TerminalSubscriptionParams.safeParse({ terminal: 'term_other' }).success).toBe(false)
  })
  it.each(['subscribe', 'unsubscribe', 'status'])(
    'forwards only verified envelope evidence for %s',
    (action) => {
      const method =
        ORCHESTRATION_SUBSCRIPTION_METHODS[
          action === 'subscribe' ? 0 : action === 'unsubscribe' ? 1 : 2
        ]
      const evidence = { terminalHandle: 'term_self', paneKey: 'tab:leaf', launchToken: 'secret' }
      const receipt = { subscribed: action === 'subscribe' }
      const terminalMailboxSubscription = vi.fn().mockReturnValue(receipt)
      const recordMutationReceipt = vi.fn()
      method.handler(
        {},
        {
          runtime: Object.assign(new OrcaRuntimeService(), { terminalMailboxSubscription }),
          orchestrationCompatibilityEvidence: evidence,
          recordMutationReceipt
        }
      )
      expect(terminalMailboxSubscription).toHaveBeenCalledWith(action, evidence)
      if (action === 'status') {
        expect(recordMutationReceipt).not.toHaveBeenCalled()
      } else {
        expect(recordMutationReceipt).toHaveBeenCalledWith(receipt)
      }
    }
  )

  it('returns current status and a separate historical receipt on replay', () => {
    const method = ORCHESTRATION_SUBSCRIPTION_METHODS[0]
    const evidence = { terminalHandle: 'term_self', paneKey: 'tab:leaf', launchToken: 'secret' }
    const terminalMailboxSubscription = vi.fn().mockReturnValue(status(false))
    const historicalReplay = status(true)
    const result = method.handler(
      {},
      {
        runtime: Object.assign(new OrcaRuntimeService(), { terminalMailboxSubscription }),
        orchestrationCompatibilityEvidence: evidence,
        replayedMutationReceipt: historicalReplay
      }
    )
    expect(result).toEqual({ ...status(false), historicalReplay })
    expect(terminalMailboxSubscription).toHaveBeenCalledWith('status', evidence)
  })

  it('binds durable replay to the verified receiver and observes current status', async () => {
    const db = new OrchestrationDb(':memory:')
    const states = new Map<string, TerminalMailboxSubscriptionStatus>()
    const evidence = (paneKey: string): OrchestrationCompatibilityEvidence => ({
      terminalHandle: `term_${paneKey}`,
      paneKey,
      launchToken: `secret-${paneKey}`
    })
    const createDispatcher = (options?: {
      processIncarnation?: string
      rejectBinding?: boolean
    }) => {
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'getTerminalMailboxSubscriptionBinding').mockImplementation((proof) => {
        if (options?.rejectBinding) {
          throw new Error('verified current terminal launch required')
        }
        const paneKey = proof?.paneKey ?? 'missing'
        return {
          hostScope: { kind: 'local', hostId: 'local' },
          terminalHandle: proof?.terminalHandle ?? 'missing',
          paneKey,
          ptyId: `pty-${paneKey}`,
          processIncarnation: options?.processIncarnation ?? `inc-${paneKey}`
        }
      })
      const mutate = vi
        .spyOn(runtime, 'terminalMailboxSubscription')
        .mockImplementation((action, proof) => {
          const paneKey = proof?.paneKey ?? 'missing'
          if (action === 'subscribe') {
            states.set(paneKey, status(true))
          } else if (action === 'unsubscribe') {
            states.set(paneKey, status(false))
          }
          return states.get(paneKey) ?? status(false)
        })
      return {
        dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_SUBSCRIPTION_METHODS }),
        mutate
      }
    }
    const request = (
      method: 'orchestration.subscribe' | 'orchestration.unsubscribe',
      requestId: string,
      proof: OrchestrationCompatibilityEvidence,
      rpcId: string
    ) => ({
      id: rpcId,
      authToken: 'token',
      method,
      params: {},
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      orchestrationCompatibilityEvidence: proof
    })
    try {
      const firstRuntime = createDispatcher()
      await expect(
        firstRuntime.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-a'), 'rpc-1')
        )
      ).resolves.toMatchObject({
        ok: true,
        result: { subscribed: true, mutation: { replayed: false } }
      })
      await firstRuntime.dispatcher.dispatch(
        request('orchestration.unsubscribe', 'unsubscribe-a', evidence('pane-a'), 'rpc-2')
      )
      await expect(
        firstRuntime.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-a'), 'rpc-3')
        )
      ).resolves.toMatchObject({
        ok: true,
        result: {
          subscribed: false,
          historicalReplay: { subscribed: true },
          mutation: { replayed: true }
        }
      })
      await expect(
        firstRuntime.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-b'), 'rpc-4')
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
      expect(states.has('pane-b')).toBe(false)

      states.clear()
      const restarted = createDispatcher()
      await expect(
        restarted.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-a'), 'rpc-5')
        )
      ).resolves.toMatchObject({
        ok: true,
        result: {
          subscribed: false,
          historicalReplay: { subscribed: true },
          mutation: { replayed: true }
        }
      })
      expect(restarted.mutate).toHaveBeenCalledWith('status', evidence('pane-a'))

      const replaced = createDispatcher({ processIncarnation: 'inc-replaced' })
      await expect(
        replaced.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-a'), 'rpc-6')
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
      expect(replaced.mutate).not.toHaveBeenCalled()

      const invalid = createDispatcher({ rejectBinding: true })
      await expect(
        invalid.dispatcher.dispatch(
          request('orchestration.subscribe', 'receiver-bound', evidence('pane-a'), 'rpc-7')
        )
      ).resolves.toMatchObject({ ok: false })
      expect(invalid.mutate).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
