import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE as turnScope } from '../../../shared/agent-session-journal-types'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  CODEX_INPUT_FINALIZATION_OWNER_OUTCOMES,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import * as autoSandbox from '../../codex/codex-structured-auto-sandbox'
import * as lifetime from './structured-agent-session-host-lifetime'
import { claimStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-start-readiness'

export function registerCodexInputFinalization(current: typeof codexInputFinalizationFixture) {
  it.each(['stop', 'exit'] as const)(
    'unwinds actual Auto preparation on %s without a late write',
    async (ending) => {
      const { host, adapter, codex, config, pick, permissionSend, stop, starts } = current()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      await pick('auto')
      const paused = Promise.withResolvers<unknown>()
      let signal: AbortSignal | undefined
      const lateReads: Promise<unknown>[] = []
      const readAuto = autoSandbox.readCodexAutoSandbox
      vi.spyOn(autoSandbox, 'readCodexAutoSandbox').mockImplementation((...args) => {
        const task = readAuto(...args)
        lateReads.push(task)
        return task
      })
      let preparing = false
      let frameEnded = false
      const dispatch = adapter.dispatch.bind(adapter)
      vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
        signal = input.signal
        codex.routes['config/read'] = (params) => {
          if (!params?.cwd) {
            return config
          }
          preparing = true
          return paused.promise
        }
        try {
          return await dispatch(input)
        } finally {
          frameEnded = true
        }
      })
      const id = await permissionSend('keep exact Auto')
      const journal = host['sessions'].get(SESSION)!.journal
      try {
        await vi.waitFor(() => expect(preparing).toBe(true))
        const session = adapter['sessions'].get(SESSION)!
        const permissions = session.permissions!
        const before = { ...permissions }
        const options = [...session.options]
        const waiting = host.waitForSendSettlement(SESSION, id)
        let answeredEarly = false
        void waiting.then(() => {
          answeredEarly = true
        })
        const resolve = journal.resolveDispatch.bind(journal)
        vi.spyOn(journal, 'resolveDispatch').mockImplementation((resolution, ...rest) => {
          if (resolution.state === 'rejected') {
            expect(answeredEarly).toBe(false)
            expect(resolution).toMatchObject({
              clientMessageId: id,
              fence: 1,
              rejection: { kind: ending === 'exit' ? 'providerExited' : 'cancelled' }
            })
            expect(resolution.rejection).toEqual(
              ending === 'exit'
                ? { kind: 'providerExited', neverReachedAgent: true }
                : { kind: 'cancelled' }
            )
            expect(resolution.reason).toMatch(/before/)
            if (ending === 'exit') {
              expect(host['sessions'].get(SESSION)?.lastEndedChild?.failure?.detail).toEqual({
                text: 'Codex exited',
                audience: 'log'
              })
            }
          }
          return resolve(resolution, ...rest)
        })
        expect(signal?.aborted).toBe(false)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        if (ending === 'stop') {
          await stop()
        } else {
          codex.connections[0]?.handlers.onExit?.(
            Object.assign(new Error('Codex exited'), {
              providerDiagnostic: { text: 'Codex exited', audience: 'log' }
            }),
            { expected: false }
          )
        }
        await vi.waitFor(() => expect(signal?.aborted && frameEnded).toBe(true))
        const answered = current().submission((await waiting)?.value)
        expect(answered).toMatchObject({
          dispatchState: 'rejected',
          fence: 1,
          rejection: { kind: ending === 'exit' ? 'providerExited' : 'cancelled' }
        })
        expect(answered).toEqual(journal.submission(id))
        expect(starts()).toHaveLength(0)
        paused.resolve(config)
        await Promise.allSettled(lateReads)
        await current().waitForInputFinalization(journal, id)
        expect(session.permissions).toBe(permissions)
        expect(permissions).toEqual(before)
        expect([...session.options]).toEqual(options)
        expect(starts()).toHaveLength(0)
      } finally {
        paused.resolve(config)
        await Promise.allSettled(lateReads)
        await current().waitForInputFinalization(journal, id)
      }
    }
  )

  it.each(CODEX_INPUT_FINALIZATION_OWNER_OUTCOMES)(
    'finishes its exact owner with %s resolution',
    async (result) => {
      const fixture = current()
      const { host, adapter, codex, turns, permissionSend, starts } = fixture
      const { sessions, serialize, conversationDelivery, runtimeState } =
        host.collaboratorsForTests()
      const old = sessions.get(SESSION)!
      const journal = old.journal
      const initialChild = old.child!
      const closed = vi.spyOn(journal, 'close')
      let currentClose = closed
      let currentJournal = journal
      const deps = conversationDelivery.loop['deps']
      const ordered = deps.serialize
      const held = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const closeCompletion = result.startsWith('new-') || result === 'safe-close'
      const closing = closeCompletion || result.startsWith('close-')
      const persistence = ['normal', 'fallback', 'failed', 'close-normal', 'close-failed'].includes(
        result
      )
      const failsBoth = result === 'failed' || result === 'close-failed'
      let signal: AbortSignal | undefined
      const beginAbort = runtimeState.acquireAborts.begin.bind(runtimeState.acquireAborts)
      vi.spyOn(runtimeState.acquireAborts, 'begin').mockImplementation((...args) => {
        const attempt = beginAbort(...args)
        if (args[1]) {
          signal = attempt.signal
        }
        return attempt
      })
      const dispatched = vi.spyOn(adapter, 'dispatch')
      const closeDecision = vi.fn<(id: string) => Promise<boolean>>()
      const delayed = vi.spyOn(deps, 'serialize').mockImplementation(async (sessionId, task) => {
        const value = await ordered(sessionId, task)
        if (result === 'null' && value && typeof value === 'object' && 'run' in value) {
          entered.resolve()
          await held.promise
        }
        return value
      })
      let retirement = Promise.resolve()
      const begin = lifetime.beginFinalizedStructuredAgentSessionClose
      const helper = vi.spyOn(lifetime, 'beginFinalizedStructuredAgentSessionClose')
      helper.mockImplementation((context, ...args) => {
        if (!closeCompletion) {
          return begin(context, ...args)
        }
        closeDecision.mockImplementation(context.closeConversation)
        return begin(
          {
            ...context,
            closeConversation: closeDecision,
            serialize: (id, task) => {
              entered.resolve()
              retirement = held.promise.then(() => context.serialize(id, task))
              return retirement
            }
          },
          ...args
        )
      })
      const response = Promise.withResolvers<unknown>()
      codex.routes['turn/start'] = () => response.promise
      if (failsBoth) {
        await serialize(SESSION, async () => {
          expect(journal.submissions()).toEqual([])
          for (const fence of [0, 1]) {
            const clientMessageId = `unrelated-${fence}`
            await journal.appendSubmission({
              clientMessageId,
              payloadFingerprint: clientMessageId,
              body: hostTestMessage('unrelated pending input'),
              fence,
              handoverRecorded: true
            })
            await journal.resolveDispatch({ clientMessageId, state: 'pending', fence, turnScope })
          }
        })
      }
      const id = await permissionSend('outcome owed after exit')
      const waiting = host.waitForSendSettlement(SESSION, id)
      let answered = false
      void waiting.then(() => {
        answered = true
      })
      const settle = deps.settleLeftovers!
      const leftovers = vi.spyOn(deps, 'settleLeftovers').mockImplementation((sessionId, owner) => {
        expect(sessionId).toBe(SESSION)
        expect(owner).toEqual(expect.any(Function))
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(finalizingStructuredAgentSessionInput(journal, id, owner)).toBe(false)
        expect(finalizingStructuredAgentSessionInput(journal, id, () => {})).toBe(true)
        if (result !== 'terminal') {
          expect(answered).toBe(false)
        }
        return settle(sessionId, owner)
      })
      const recover = journal.appendPlannedLifecycleBatch.bind(journal)
      const recovered = vi.spyOn(journal, 'appendPlannedLifecycleBatch')
      recovered.mockImplementation((batch) => {
        expect(batch.fence).toBe(current().conversationFence())
        return recover(batch)
      })
      const resolve = journal.resolveDispatch.bind(journal)
      const wake = conversationDelivery.loop.wake.bind(conversationDelivery.loop)
      const deferredWake = vi.spyOn(conversationDelivery.loop, 'wake')
      let stopping = Promise.resolve()
      let closeStarted = false
      let writes = 0
      function assertStoppedHandle() {
        expect(sessions.get(SESSION)).toBe(old)
        expect(closed).not.toHaveBeenCalled()
        expect(old.child).toBeNull()
        expect(host['deps'].store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      }
      try {
        if (result === 'null') {
          await entered.promise
          expect(old.child?.phase).toBe('ready')
          expect(signal?.aborted).toBe(false)
        } else {
          await vi.waitFor(() => expect(starts()).toHaveLength(1))
        }
        if (result === 'terminal') {
          turns.routes['turn/start']()
          turns.start()
          turns.echo(id)
          await vi.waitFor(async () =>
            expect(journal.submission(id)).toMatchObject({ dispatchState: 'accepted' })
          )
        }
        const cutoff = journal.cursor().sequence
        if (closing) {
          closeStarted = true
          stopping = host.close(SESSION, 'user-close')
          await stopping
        } else if (result !== 'live') {
          if (result === 'null') {
            expect(await adapter.closeSession(SESSION)).toBe(true)
          } else {
            codex.connections[0]!.handlers.onExit?.(new Error('Codex exited after write'), {
              expected: false
            })
          }
          await serialize(SESSION, async () => {})
        }
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(closed).not.toHaveBeenCalled()
        if (result !== 'terminal') {
          expect(journal.submission(id)).toMatchObject({ dispatchState: 'pending' })
          expect(host.currentWork(SESSION)?.owesSend(journal.submission(id)!)).toBe(true)
        }
        if (result !== 'live') {
          assertStoppedHandle()
        }
        if (failsBoth) {
          const fence = recovered.mock.calls.at(-1)![0].fence
          for (const previous of [0, 1]) {
            expect(journal.submission(`unrelated-${previous}`)).toMatchObject({
              clientMessageId: `unrelated-${previous}`,
              payloadFingerprint: `unrelated-${previous}`,
              dispatchState: 'unknown',
              recovered: true,
              fence
            })
          }
        }
        if (result === 'null') {
          expect(signal?.aborted).toBe(false)
          expect(dispatched).not.toHaveBeenCalled()
          expect(old.lastEndedChild).toMatchObject({
            fence: initialChild.fence,
            generation: initialChild.generation
          })
        }
        if (persistence) {
          vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (...args) => {
            if (args[0].state === 'unknown') {
              writes += 1
              if (writes === 1) {
                entered.resolve()
                await held.promise
              }
              if (failsBoth || (result === 'fallback' && writes === 1)) {
                throw new Error('controlled result persistence failure')
              }
            }
            return resolve(...args)
          })
          response.reject(new CodexAppServerTimeoutError('lost written reply'))
          await entered.promise
          assertStoppedHandle()
          expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
          expect(journal.submission(id)?.dispatchState).toBe('pending')
          expect(answered).toBe(false)
          if (closing) {
            expect(codex.connections[0]?.closeCount).toBeGreaterThan(0)
          }
        } else {
          response.resolve({})
        }
        if (closeCompletion) {
          await entered.promise
          expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)
          const ended = old.lastEndedChild
          expect(leftovers).toHaveBeenCalledOnce()
          if (result === 'new-session') {
            const opened = await openStructuredAgentSessionConversationJournal(
              host['deps'],
              host['deps'].store.getRecord(SESSION)!
            )
            sessions.set(SESSION, opened.session)
            currentJournal = opened.session.journal
            currentClose = vi.spyOn(opened.session.journal, 'close')
            expect(opened.session).not.toBe(old)
            expect(currentJournal).not.toBe(journal)
            expect(sessions.get(SESSION)).toBe(opened.session)
            expect(opened.session.child).toBeNull()
            expect(currentJournal.pendingSubmissions()).toEqual([])
          } else if (result === 'new-send') {
            deferredWake.mockResolvedValue()
            const newer = await permissionSend('new durably accepted input')
            expect(journal.submission(newer)?.acceptedSequence).toBeGreaterThan(cutoff)
            expect(old.child).toBeNull()
          } else if (result !== 'safe-close') {
            const claim = await serialize(SESSION, async () =>
              claimStructuredAgentSessionAgent(host['attachContext'](), SESSION)
            )
            expect(await claim.outcome).toMatchObject({ ok: true })
            const child = old.child!
            expect(await runtimeState.startupAttempts.readiness(SESSION, child)?.wait()).toBe(
              'ready'
            )
            expect(child.phase).toBe('ready')
            expect(child.fence).toBe(current().conversationFence())
            expect(child.generation).not.toBe(ended?.generation)
            if (result === 'new-ended-child') {
              expect(await adapter.closeSession(SESSION)).toBe(true)
              await serialize(SESSION, async () => {})
              expect(old.child).toBeNull()
              expect(old.lastEndedChild).not.toBe(ended)
            }
          }
          if (result !== 'new-ended-child' && result !== 'new-session') {
            expect(old.lastEndedChild).toBe(ended)
          }
          if (result !== 'new-send') {
            expect(journal.submissions().some((s) => (s.acceptedSequence ?? 0) > cutoff)).toBe(
              false
            )
          }
          expect(closed).not.toHaveBeenCalled()
          expect(currentClose).not.toHaveBeenCalled()
        }
        held.resolve()
        await retirement
        await fixture.waitForInputFinalization(journal, id)
        expect(starts()).toHaveLength(result === 'null' ? 0 : 1)
        expect(deps.deliveryOrder?.hasActiveSend(SESSION)).toBe(false)
        expect(leftovers).toHaveBeenCalledTimes(
          ['null', 'admitted', 'terminal'].includes(result) || closeCompletion ? 1 : 0
        )
        if (result === 'live') {
          expect(journal.submission(id)?.dispatchState).toBe('pending')
          expect(leftovers).not.toHaveBeenCalled()
        } else if (failsBoth) {
          expect(writes).toBe(2)
          expect(journal.submission(id)?.dispatchState).toBe('pending')
          assertStoppedHandle()
          expect(
            journal.submissions().filter((s) => s.clientMessageId.startsWith('unrelated-'))
          ).toHaveLength(2)
          vi.mocked(journal.resolveDispatch).mockRestore()
          await fixture.assertInputRecoveredAfterSnapshot(id)
        } else {
          expect(fixture.submission((await waiting)?.value)?.dispatchState).toBe(
            result === 'terminal' ? 'accepted' : 'unknown'
          )
          expect(fixture.submission((await waiting)?.value)).toEqual(journal.submission(id))
          if (persistence) {
            expect(writes).toBe(result === 'fallback' ? 2 : 1)
          }
        }
        if (closeCompletion) {
          expect(closeDecision).toHaveBeenCalledTimes(result === 'safe-close' ? 1 : 0)
          if (result === 'safe-close') {
            expect(sessions.has(SESSION)).toBe(false)
            expect(closed).toHaveBeenCalledOnce()
          } else {
            expect(sessions.get(SESSION)?.journal).toBe(currentJournal)
            expect(currentClose).not.toHaveBeenCalled()
          }
        }
      } finally {
        response.resolve({})
        held.resolve()
        await stopping
        await fixture.waitForInputFinalization(journal, id)
        if (closeCompletion && closeStarted) {
          await entered.promise
        }
        await retirement
        delayed.mockRestore()
        helper.mockRestore()
        deferredWake.mockRestore()
        if (result === 'new-send') {
          await wake(SESSION)
        }
        if (result === 'new-session') {
          await journal.close()
        }
      }
    }
  )

  it.each(['retire', 'acquire', 'readiness', 'rebind', 'starting-exit'] as const)(
    'ends previously positive continuation at actual %s',
    async (boundary) => {
      const { host, adapter, codex, permissionSend, pick, stop, starts } = current()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      await pick('auto')
      const { sessions, conversationDelivery, runtimeState } = host.collaboratorsForTests()
      const journal = sessions.get(SESSION)!.journal
      const original = sessions.get(SESSION)!.child!
      const deps = conversationDelivery.loop['deps']
      const held = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const outcomes: Promise<unknown>[] = []
      const readyWaits: Mock<StructuredAgentSessionStartReadiness['wait']>[] = []
      const opened = vi.spyOn(adapter, 'open')
      const start = deps.startProviderChild
      vi.spyOn(deps, 'startProviderChild').mockImplementation((...args) => {
        const claim = start(...args)
        outcomes.push(claim.outcome)
        return claim
      })
      const dispatch = adapter.dispatch.bind(adapter)
      let signal: AbortSignal | undefined
      vi.spyOn(adapter, 'dispatch').mockImplementation((input) => {
        signal = input.signal
        return dispatch(input)
      })
      const retire = deps.retireOutgrownChild
      const retired = vi.spyOn(deps, 'retireOutgrownChild').mockImplementation(async (...args) => {
        if (
          boundary === 'retire' &&
          args[1] &&
          continuingStructuredAgentSessionInput(journal, args[1])
        ) {
          entered.resolve()
          await held.promise
        }
        return retire(...args)
      })
      const open = codex.routes['thread/start']!
      const opening = vi.fn(async (params: Parameters<typeof open>[0]) => {
        if (boundary === 'acquire' || boundary === 'starting-exit') {
          entered.resolve()
          await held.promise
        }
        return open(params)
      })
      codex.routes['thread/start'] = codex.routes['thread/resume'] = opening
      const readiness = deps.readiness
      vi.spyOn(deps, 'readiness').mockImplementation((...args) => {
        const ready = readiness(...args)
        if (!ready) {
          return ready
        }
        const wait = vi.fn(async (...budget: Parameters<typeof ready.wait>) => {
          const result = await ready.wait(...budget)
          if (boundary === 'readiness' && args[1] !== original) {
            entered.resolve()
            await held.promise
          }
          return result
        })
        readyWaits.push(wait)
        return { wait }
      })
      const resolve = journal.resolveDispatch.bind(journal)
      let reboundFence: number | undefined
      const rebound = vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (...args) => {
        if (
          boundary === 'rebind' &&
          args[0].state === 'pending' &&
          args[0].fence !== original.fence &&
          args[0].fence === sessions.get(SESSION)?.child?.fence
        ) {
          reboundFence = args[0].fence
          entered.resolve()
          await held.promise
        }
        return resolve(...args)
      })
      async function drainForwarded() {
        await Promise.allSettled(retired.mock.results.map((result) => result.value))
        await Promise.allSettled(outcomes)
        const results = [
          ...opening.mock.results,
          ...opened.mock.results,
          ...rebound.mock.results,
          ...readyWaits.flatMap((call) => call.mock.results)
        ]
        await Promise.allSettled(
          results.map((result) => (result.type === 'return' ? result.value : undefined))
        )
      }
      const id = await permissionSend('same original input', { personality: 'friendly' })
      const waiting = host.waitForSendSettlement(SESSION, id)
      const originalBody = hostTestMessage('same original input')
      // Ready-child exit proof settles before lease release; terminal rows keep that fence.
      const settlesAtChildFence = boundary === 'readiness' || boundary === 'rebind'
      let boundFence = journal.submission(id)!.fence
      let stopping: Promise<unknown> = Promise.resolve()
      try {
        await entered.promise
        expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(signal?.aborted).toBe(false)
        const child = sessions.get(SESSION)?.child
        expect(journal.submission(id)).toMatchObject({
          clientMessageId: id,
          options: { personality: 'friendly' }
        })
        expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(originalBody)
        boundFence = child?.fence ?? journal.submission(id)!.fence
        if (boundary === 'rebind') {
          expect(reboundFence).toBe(child!.fence)
        }
        if (child) {
          expect(child).toMatchObject({
            fence: current().conversationFence(),
            generation: boundary === 'retire' ? 'generation-1' : 'generation-2'
          })
        }
        expect(boundFence).toBe(boundary === 'retire' ? original.fence : original.fence + 2)
        if (boundary === 'starting-exit') {
          const abort = runtimeState.acquireAborts.abort.bind(runtimeState.acquireAborts)
          let observed = false
          const first = vi
            .spyOn(runtimeState.acquireAborts, 'abort')
            .mockImplementation((...args) => {
              if (!observed) {
                observed = true
                expect(sessions.get(SESSION)?.child?.phase).toBe('starting')
                expect(signal?.aborted).toBe(false)
              }
              return abort(...args)
            })
          codex.connections[1]!.handlers.onExit?.(new Error('startup exit'), { expected: false })
          await vi.waitFor(() => expect(first).toHaveBeenCalled())
        } else {
          stopping = stop()
        }
        expect(signal?.aborted).toBe(true)
        expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
        held.resolve()
        await stopping
        await drainForwarded()
        await current().waitForInputFinalization(journal, id)
        expect(journal.submission(id)).toMatchObject({
          clientMessageId: id,
          dispatchState: 'rejected',
          fence: settlesAtChildFence ? boundFence : current().conversationFence(),
          rejection: { kind: boundary === 'starting-exit' ? 'providerStartFailed' : 'cancelled' },
          options: { personality: 'friendly' }
        })
        expect(current().submission((await waiting)?.value)).toEqual(journal.submission(id))
        expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(originalBody)
        expect(journal.submission(id)?.reason).toMatch(
          boundary === 'starting-exit' ? /before/ : /provider_cancelled_before_start/
        )
        expect(journal.submission(id)?.rejection).not.toHaveProperty('neverReachedAgent')
        expect(starts()).toHaveLength(0)
        expect(codex.connections).toHaveLength(boundary === 'retire' ? 1 : 2)
      } finally {
        held.resolve()
        await stopping
        await drainForwarded()
        await current().waitForInputFinalization(journal, id)
        vi.restoreAllMocks()
      }
    }
  )
}
