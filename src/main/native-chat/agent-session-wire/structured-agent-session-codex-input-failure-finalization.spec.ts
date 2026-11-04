import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { expect, it, vi } from 'vitest'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { CodexAppServerTimeoutError } from '../../codex/app-server/codex-app-server-session'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

export function registerCodexInputFailureFinalization(
  current: typeof codexInputFinalizationFixture
) {
  it.each([
    'stop',
    'exit',
    'crash',
    'refusal',
    'unproven-exit',
    'lost-reply',
    'lost-steer',
    'post-write-stop'
  ] as const)('bounds %s without replaying possibly written input', async (failure) => {
    const {
      host,
      adapter,
      codex,
      permissionSend,
      pick,
      stop,
      row,
      starts,
      turns,
      began,
      assertInputRecoveredAfterSnapshot
    } = current()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const uncertain = failure.startsWith('lost-')
    const written = uncertain || failure === 'post-write-stop'
    const { sessions, runtimeState } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const persisted = vi.spyOn(journal, 'resolveDispatch')
    if (failure === 'lost-steer') {
      await began(await permissionSend('running', { personality: 'friendly' }))
    }
    const paused = Promise.withResolvers<void>()
    const preparing = Promise.withResolvers<void>()
    const dispatch = adapter.dispatch.bind(adapter)
    vi.spyOn(adapter, 'dispatch').mockImplementation((input) =>
      dispatch({
        ...input,
        beforeDispatch: async () => {
          await input.beforeDispatch?.()
          preparing.resolve()
          await waitForPromiseWithSignal(paused.promise, input.signal)
        }
      })
    )
    const id = await permissionSend('preserve me', { personality: 'friendly' })
    await preparing.promise
    await pick(failure === 'lost-steer' ? 'full-access' : 'auto')
    if (failure === 'refusal') {
      codex.routes['thread/start'] = codex.routes['thread/resume'] = () => {
        throw new AgentSessionAcquisitionRefusal('missing Codex', 'cliMissing')
      }
    }
    if (failure === 'lost-reply' || failure === 'lost-steer') {
      codex.routes[failure === 'lost-steer' ? 'turn/steer' : 'turn/start'] = () => {
        throw new CodexAppServerTimeoutError('lost turn reply')
      }
    }
    if (failure === 'unproven-exit') {
      vi.spyOn(adapter, 'disposeSession').mockResolvedValue(false)
    }
    const lost = Promise.withResolvers<unknown>()
    const responseObserved = lost.promise.catch(() => {})
    if (failure === 'post-write-stop') {
      codex.routes['turn/start'] = () => lost.promise
    }
    paused.resolve()
    if (failure === 'post-write-stop') {
      await vi.waitFor(() => expect(starts()).toHaveLength(1))
      const session = host.collaboratorsForTests().sessions.get(SESSION)!
      const child = session.child!
      const provider = adapter['sessions'].get(SESSION)!
      expect(turns.turnId).toBeNull()
      const stopped = stop()
      lost.reject(new CodexAppServerTimeoutError('lost reply after Stop'))
      expect(await stopped).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(session.child).toBeNull())
      expect(session.lastEndedChild).toMatchObject({
        fence: child.fence,
        generation: child.generation,
        cause: 'user-stop',
        rootGone: true
      })
      expect(provider.ended).toBe(true)
      expect(provider.connection.closed).toBe(true)
      expect(await row(id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'cancelled' },
        recovered: true
      })
    }
    if (failure === 'stop' || failure === 'exit' || failure === 'crash') {
      const compiling = Promise.withResolvers<unknown>()
      const open = codex.routes['thread/start']!
      codex.routes['thread/start'] = codex.routes['thread/resume'] = () => compiling.promise
      await vi.waitFor(() => expect(codex.connections).toHaveLength(2))
      await vi.waitFor(() => expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true))
      if (failure === 'crash') {
        expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
        await assertInputRecoveredAfterSnapshot(id)
      }
      if (failure === 'exit') {
        await vi.waitFor(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
        const failed = sessions.get(SESSION)!.child!
        const owner = structuredAgentSessionHandingOver(journal).get(id)?.input?.owner
        const flight = runtimeState.startFlights.get(SESSION)!
        const originalSignal = structuredAgentSessionHandingOver(journal).get(id)?.input?.signal
        expect(originalSignal?.aborted).toBe(false)
        expect(owner).toEqual(expect.any(Function))
        expect(flight.signal?.aborted).toBe(false)
        let retries = 0
        codex.routes['thread/start'] = codex.routes['thread/resume'] = () => {
          retries += 1
          expect(originalSignal?.aborted).toBe(false)
          expect(runtimeState.startFlights.get(SESSION)?.signal).toBe(flight.signal)
          expect(structuredAgentSessionHandingOver(journal).get(id)?.input?.owner).toBe(owner)
          expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true)
          expect(journal.submission(id)).toMatchObject({ dispatchState: 'pending', fence: 1 })
          expect(starts()).toHaveLength(0)
          throw new CodexAppServerRequestError(
            'thread/resume',
            -32001,
            'Server overloaded; retry later.',
            'Server overloaded; retry later.'
          )
        }
        codex.connections[1]?.handlers.onExit?.(new Error('Codex died before ready'), {
          expected: false
        })
        await vi.waitFor(() =>
          expect(sessions.get(SESSION)?.lastEndedChild).toMatchObject({
            fence: failed.fence,
            generation: failed.generation,
            rootGone: true
          })
        )
        expect(flight.signal?.aborted).toBe(false)
        compiling.resolve(open({}))
        const outcome = await flight.outcome
        expect(outcome).toMatchObject({ ok: false })
        expect(outcome).not.toHaveProperty('aborted')
        expect(retries).toBe(4)
        expect(originalSignal?.aborted).toBe(false)
        expect(runtimeState.startFlights.get(SESSION)).toBeUndefined()
      } else {
        expect(await stop()).toMatchObject({ ok: true })
        compiling.resolve(open({}))
      }
    }
    await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
    const writes = await Promise.allSettled(persisted.mock.results.map((result) => result.value))
    expect(writes.filter((result) => result.status === 'rejected')).toEqual([])
    await vi.waitFor(async () =>
      expect((await row(id))?.dispatchState).toBe(uncertain ? 'unknown' : 'rejected')
    )
    if (failure === 'unproven-exit') {
      expect((await row(id))?.rejection).toMatchObject({
        kind: 'restartFailed',
        refusal: {
          code: 'agent_session_ownership_unknown',
          details: { reason: 'previousExitUnverifiable' }
        }
      })
    }
    if (failure === 'exit') {
      expect(journal.submission(id)).toMatchObject({
        clientMessageId: id,
        rejection: { kind: 'startFailed' },
        options: { personality: 'friendly' }
      })
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(
        hostTestMessage('preserve me')
      )
      expect(current().submission((await host.waitForSendSettlement(SESSION, id))?.value)).toEqual(
        journal.submission(id)
      )
    }
    expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
    expect(starts()).toHaveLength(written ? 1 : 0)
    lost.resolve({})
    await responseObserved
    expect(codex.connections).toHaveLength(
      failure === 'exit' ? 6 : failure === 'lost-steer' || failure === 'unproven-exit' ? 1 : 2
    )
  })
}
