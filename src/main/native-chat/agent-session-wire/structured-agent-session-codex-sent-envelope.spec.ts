import {
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

import { expect, it, vi } from 'vitest'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'

export function registerCodexSentEnvelope(
  get: () => ReturnType<typeof codexInputFinalizationFixture>
): void {
  it.each(['stop', 'local-abort'] as const)(
    'keeps an actual sent envelope when %s precedes its Promise delivery and the reply is lost',
    async (cancellation) => {
      const { host, adapter, codex, turns, starts, permissionSend, row, stop, submission } = get()

      const collaborators = host.collaboratorsForTests()
      const session = collaborators.sessions.get(SESSION)!
      const journal = session.journal
      const hostChild = session.child!
      const provider = adapter['sessions'].get(SESSION)!
      const translator = provider.translator
      Object.defineProperty(provider.connection, 'closeResult', {
        get: () => (provider.connection.closed ? { root: 'exited', tree: 'exited' } : undefined)
      })
      const echoed = vi.spyOn(provider.dispatchEchoes, 'settle')
      const persisted = vi.spyOn(journal, 'resolveDispatch')
      const accepted = vi.spyOn(journal, 'acceptLate')
      const settledLate = vi.spyOn(host, 'settleLateDispatch')
      const deps = collaborators.conversationDelivery.loop['deps']
      const ordered = deps.serialize
      const lost = Promise.withResolvers<unknown>()
      const responseObserved = lost.promise.catch(() => {})
      const replyLost = new CodexAppServerTimeoutError('reply lost after the write')
      const entered = Promise.withResolvers<void>()
      const delivery = Promise.withResolvers<void>()
      const frameDelivery = Promise.withResolvers<void>()
      const forwarded: Promise<unknown>[] = []
      codex.routes['turn/start'] = () => lost.promise
      let stopping: Promise<unknown> | undefined
      let frameEnded = false
      let delivered = false
      const dispatch = adapter.dispatch.bind(adapter)
      let restoreSerialize: (() => void) | undefined
      const dispatched = vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
        const serialized = vi.spyOn(deps, 'serialize').mockImplementation((sessionId, task) => {
          const invoked = ordered(sessionId, task)
          const resultDelivery = invoked.then(async (result) => {
            if (
              result &&
              typeof result === 'object' &&
              'kind' in result &&
              result.kind === 'sent'
            ) {
              expect(result).toMatchObject({ kind: 'sent', response: expect.any(Promise) })
              expect(starts()[0]?.params?.clientUserMessageId).toBe(input.clientMessageId)
              entered.resolve()
              await delivery.promise
              delivered = true
            }
            return result
          })
          forwarded.push(invoked, resultDelivery)
          return resultDelivery
        })
        restoreSerialize = () => serialized.mockRestore()
        try {
          return await dispatch(input)
        } finally {
          if (cancellation === 'stop') {
            await frameDelivery.promise
          }
          frameEnded = true
        }
      })
      const id = await permissionSend('one actual write')
      const waiting = host.waitForSendSettlement(SESSION, id)
      const waiterObserved = vi.fn()
      const waiterObserver = waiting.then(waiterObserved, waiterObserved)
      let bodyError: unknown
      let bodyFailed = false
      const cleanupErrors: unknown[] = []
      try {
        await entered.promise
        expect(starts()).toHaveLength(1)
        expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(frameEnded).toBe(false)
        expect(waiterObserved).not.toHaveBeenCalled()
        expect(delivered).toBe(false)
        if (cancellation === 'stop') {
          stopping = stop()
        } else {
          expect(
            collaborators.runtimeState.acquireAborts.abort(SESSION, 'local wait cancelled')
          ).toEqual({ reached: true, handedOver: true })
        }
        await vi.waitFor(() => expect(dispatched.mock.calls[0]?.[0].signal?.aborted).toBe(true))
        expect(delivered).toBe(false)
        expect(frameEnded).toBe(false)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        delivery.resolve()
        lost.reject(replyLost)
        if (cancellation === 'stop') {
          expect(await stopping).toMatchObject({ ok: true })
          await vi.waitFor(() => expect(session.child).toBeNull())
          expect(session.lastEndedChild).toMatchObject({
            fence: hostChild.fence,
            generation: hostChild.generation,
            cause: 'user-stop',
            rootGone: true
          })
          expect(provider.ended).toBe(true)
          expect(provider.connection.closed).toBe(true)
          expect(turns.turnId).toBeNull()
          expect(frameEnded).toBe(false)
          expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
          expect(submission((await waiting)?.value)).toMatchObject({
            dispatchState: 'rejected',
            rejection: { kind: 'cancelled' },
            recovered: true
          })
          expect(
            (await host.journalSnapshot(SESSION)).items.filter(
              (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
            )
          ).toHaveLength(1)
        } else {
          expect(submission((await waiting)?.value)).toMatchObject({ dispatchState: 'unknown' })
          expect(session.child).toBe(hostChild)
          expect(session.lastEndedChild).toBeUndefined()
          expect(journal.queuedMessages.userStopInForce()).toBeNull()
          expect(adapter['sessions'].get(SESSION)).toBe(provider)
          expect(provider.connection).toBe(codex.connections[0])
          expect(provider.connection.closed).toBe(false)
          expect(codex.connections[0]?.closeCount).toBe(0)
          expect(provider.ended).toBe(false)
          expect(provider.translator).toBe(translator)
          expect(translator).not.toBeNull()
          turns.routes['turn/start']()
          turns.start()
          turns.echo(id)
          await vi.waitFor(async () =>
            expect(await row(id)).toMatchObject({
              dispatchState: 'accepted',
              providerItemId: `codex:${THREAD}:turn-1:0`
            })
          )
          expect(echoed).toHaveBeenCalledWith(id)
          expect(echoed.mock.results.some((result) => result.value === true)).toBe(true)
          expect(accepted).toHaveBeenCalledTimes(1)
          expect(settledLate).toHaveBeenCalledWith({
            sessionId: SESSION,
            clientMessageId: id,
            providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
          })
        }
        frameDelivery.resolve()
        await vi.waitFor(() =>
          expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)
        )
        expect(structuredAgentSessionHandingOver(journal).has(id)).toBe(false)
        expect(dispatched).toHaveBeenCalledTimes(1)
        expect(starts()).toHaveLength(1)
        expect(codex.connections).toHaveLength(1)
        expect(frameEnded).toBe(true)
        await waiterObserver
        expect(waiterObserved).toHaveBeenCalledTimes(1)
      } catch (error) {
        bodyFailed = true
        bodyError = error
      } finally {
        let frames: PromiseSettledResult<unknown>[] | undefined
        let drains: PromiseSettledResult<unknown>[] | undefined
        try {
          try {
            delivery.resolve()
            frameDelivery.resolve()
            lost.reject(replyLost)
            frames = await Promise.allSettled(dispatched.mock.results.map((result) => result.value))
            await vi.waitFor(() =>
              expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)
            )
            drains = await Promise.allSettled([
              responseObserved,
              waiterObserver,
              stopping,
              ...forwarded,
              ...settledLate.mock.results.map((result) => result.value),
              ...accepted.mock.results.map((result) => result.value),
              ...persisted.mock.results.map((result) => result.value)
            ])
            await host.flushStreamedEvents(SESSION)
          } finally {
            for (const restore of [
              () => restoreSerialize?.(),
              () => dispatched.mockRestore(),
              () => settledLate.mockRestore(),
              () => accepted.mockRestore(),
              () => persisted.mockRestore(),
              () => echoed.mockRestore()
            ]) {
              try {
                restore()
              } catch (error) {
                cleanupErrors.push(error)
              }
            }
          }
        } catch (cleanup) {
          cleanupErrors.unshift(cleanup)
        }
        if (frames !== undefined) {
          try {
            expect(frames).toEqual([{ status: 'rejected', reason: replyLost }])
          } catch (cleanup) {
            cleanupErrors.push(cleanup)
          }
        }
        if (drains !== undefined) {
          try {
            expect(drains.filter((result) => result.status === 'rejected')).toEqual([])
          } catch (cleanup) {
            cleanupErrors.push(cleanup)
          }
        }
      }
      if (cleanupErrors.length > 0) {
        if (bodyFailed) {
          throw new AggregateError(
            [bodyError, ...cleanupErrors],
            'sent envelope body and cleanup failed'
          )
        }
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0]
        }
        throw new AggregateError(cleanupErrors, 'sent envelope cleanup failed')
      }

      if (bodyFailed) {
        throw bodyError
      }
    }
  )
}
