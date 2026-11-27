import { expect, it } from 'vitest'
import { CodexAppServerRequestError } from '../../../../codex/app-server/codex-app-server-request-error'
import type { CodexTurnHost } from '../../../../codex/structured/turns/codex-structured-turn-contract'
import { createCodexDispatchEchoes } from '../../../../codex/structured/turns/codex-structured-dispatch-echo'
import { dispatchCodexTurn } from '../../../../codex/structured/turns/codex-structured-turn-start'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  faultingReceiptPublisher,
  openReceiptStream
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'

it.each(['start', 'steer', 'refused-steer', 'echo-first', 'throw', 'reject'] as const)(
  'uses only a live fresh Codex start reply to stamp receipt (%s)',
  async (mode) => {
    const rig = await createQueuedMessageTestRig()
    const completed = Promise.withResolvers<void>()
    const methods: string[] = []
    try {
      const stream = await openReceiptStream(rig)
      const fails = mode === 'throw' || mode === 'reject'
      const publisher = fails ? faultingReceiptPublisher(mode) : undefined
      const admitted = Promise.withResolvers<unknown>()
      rig.dispatch.mockImplementationOnce(async (input) => {
        const activeTurnIds = new Set(mode.includes('steer') ? ['previous'] : [])
        const dispatchEchoes = createCodexDispatchEchoes()
        const request: CodexTurnHost['connection']['request'] = async (
          method,
          _params,
          options
        ) => {
          methods.push(method)
          if (mode === 'refused-steer' && method === 'turn/steer') {
            activeTurnIds.clear()
            throw new CodexAppServerRequestError(method, -32602, 'Turn is no longer running')
          }
          if (mode === 'echo-first') {
            await rig.settleAccepted(input.clientMessageId, 'before-reply')
            // The real Codex journal's acceptance callback retires correlation after COMMIT.
            dispatchEchoes.settle(input.clientMessageId)
          }
          const reply = { turn: { id: method === 'turn/steer' ? 'previous' : 'fresh' } }
          options?.onReply?.(reply)
          return reply
        }
        try {
          const outcome = await dispatchCodexTurn(
            {
              fence: input.fence,
              events: publisher
                ? { recordProviderReceipt: publisher.publish }
                : rig.providerEvents(),
              connection: { request },
              threadId: THREAD,
              options: new Map(),
              dispatchEchoes,
              activeTurnIds,
              turnOpenWaits: { wait: async () => {} }
            },
            input,
            undefined,
            () => NOW + 250
          )
          admitted.resolve(outcome)
          return outcome
        } catch (error) {
          admitted.resolve(error)
          throw error
        } finally {
          completed.resolve()
        }
      })
      const id = await rig.workingSend()
      await completed.promise
      await rig.host.serialize(CHAT, async () => {})
      expect(methods).toEqual(
        mode === 'refused-steer'
          ? ['turn/steer', 'turn/start']
          : [mode === 'steer' ? 'turn/steer' : 'turn/start']
      )
      if (mode === 'start' || mode === 'refused-steer') {
        await eventually(() =>
          expect(stream.frames[1]?.updates).toEqual([
            { clientMessageId: id, observedAt: NOW + 250 }
          ])
        )
      } else {
        expect(stream.frames).toHaveLength(1)
      }
      if (publisher) {
        expect(publisher.publish).toHaveBeenCalledTimes(1)
        if (mode === 'reject') {
          expect(publisher.handled).toHaveBeenCalledOnce()
        }
        expect(await admitted.promise).toMatchObject({ state: 'admitted' })
        await rig.settleAccepted(id, 'echo-after-receipt-fault')
        expect((await rig.submission(id))?.dispatchState).toBe('accepted')
      }
      stream.close()
    } finally {
      await rig.dispose()
    }
  }
)
