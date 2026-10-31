import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE as turnScope } from '../../../shared/agent-session-journal-types'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  CODEX_INPUT_FINALIZATION_OWNER_OUTCOMES,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import * as lifetime from './structured-agent-session-host-lifetime'
import { claimStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

export function registerCodexInputFinalization(current: typeof codexInputFinalizationFixture) {
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
    await pick('auto')
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
        await vi.waitFor(() =>
          expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true)
        )
        expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
        await assertInputRecoveredAfterSnapshot(id)
      }
      if (failure === 'exit') {
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
            -32000,
            'startup failed',
            'startup failed'
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
              host['deps'].store.getConversation(SESSION)!
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

  it.each([
    'retire',
    'acquire',
    'readiness',
    'rebind',
    'starting-exit',
    'close-acquire',
    'close-readiness'
  ] as const)('ends previously positive continuation at actual %s', async (stage) => {
    const closing = stage.startsWith('close-')
    const boundary = stage.replace('close-', '')
    const { host, adapter, codex, turns, permissionSend, pick, stop, starts } = current()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    await pick('auto')
    const { sessions, conversationDelivery } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const original = sessions.get(SESSION)!.child!
    const deps = conversationDelivery.loop['deps']
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const outcomes: Promise<unknown>[] = []
    const retryEntered = Promise.withResolvers<void>()
    const retryReady = Promise.withResolvers<void>()
    const opened = vi.spyOn(adapter, 'open')
    const start = deps.startProviderChild
    vi.spyOn(deps, 'startProviderChild').mockImplementation((...args) => {
      const claim = start(...args)
      outcomes.push(claim.outcome)
      const outcome = claim.outcome.then(async (result) => {
        if (boundary === 'readiness' && result.ok) {
          expect(sessions.get(SESSION)?.child?.phase).toBe('ready')
          entered.resolve()
          await held.promise
        }
        return result
      })
      outcomes.push(outcome)
      return { ...claim, outcome }
    })
    const dispatch = adapter.dispatch.bind(adapter)
    let signal: AbortSignal | undefined
    const signals: (AbortSignal | undefined)[] = []
    vi.spyOn(adapter, 'dispatch').mockImplementation((input) => {
      signal = input.signal
      signals.push(signal)
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
        if (boundary === 'starting-exit' && codex.connections.length > 2) {
          retryEntered.resolve()
          await retryReady.promise
        } else {
          entered.resolve()
          await held.promise
        }
      }
      return open(params)
    })
    codex.routes['thread/start'] = codex.routes['thread/resume'] = opening
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
      const results = [...opening.mock.results, ...opened.mock.results, ...rebound.mock.results]
      await Promise.allSettled(
        results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
    }
    const stoppedX = 'stopped-before-carrier'
    if (boundary === 'retire') {
      await host.collaboratorsForTests().serialize(SESSION, async () => {
        await journal.appendSubmission({
          clientMessageId: stoppedX,
          payloadFingerprint: stoppedX,
          body: hostTestMessage('earlier stopped X'),
          source: { kind: 'user' },
          origin: 'client',
          handoverRecorded: true,
          fence: original.fence
        })
        await journal.stops.accept({
          event: { reason: 'user-stop' },
          fence: original.fence,
          liveTurnId: () => null
        })
      })
      expect(journal.submission(stoppedX)?.rejection).toMatchObject({ neverReachedAgent: true })
    }
    const id = await permissionSend('same original input', { personality: 'friendly' })
    const waiting = host.waitForSendSettlement(SESSION, id)
    const originalBody = hostTestMessage('same original input')
    // Ready replacement-child exit proof settles before lease release; terminal rows keep that fence.
    const settlesAtChildFence = ['readiness', 'rebind'].includes(boundary)
    let stopping: Promise<unknown> = Promise.resolve()
    try {
      await entered.promise
      expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true)
      expect(signal?.aborted).toBe(false)
      if (boundary === 'retire') {
        expect(journal.stoppedHistoryCarried().get(id)).toEqual([stoppedX])
      }
      const child = sessions.get(SESSION)?.child
      expect(journal.submission(id)).toMatchObject({
        clientMessageId: id,
        options: { personality: 'friendly' }
      })
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(originalBody)
      const boundFence = child?.fence ?? journal.submission(id)!.fence
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
        const originalSignal = signal
        const owner = structuredAgentSessionHandingOver(journal).get(id)?.input?.owner
        expect(owner).toEqual(expect.any(Function))
        codex.connections[1]!.handlers.onExit?.(new Error('startup exit'), { expected: false })
        await retryEntered.promise
        expect(sessions.get(SESSION)?.lastEndedChild).toMatchObject({
          fence: child!.fence,
          generation: child!.generation,
          rootGone: true
        })
        expect(originalSignal?.aborted).toBe(false)
        expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(structuredAgentSessionHandingOver(journal).get(id)?.input?.owner).toBe(owner)
        expect(journal.submission(id)).toMatchObject({
          dispatchState: 'pending',
          fence: original.fence
        })
        expect(starts()).toHaveLength(0)
        await pick('ask')
        const replacement = sessions.get(SESSION)!.child!
        expect(replacement.fence).toBe(current().conversationFence())
        expect(replacement.generation).not.toBe(child!.generation)
        retryReady.resolve()
        held.resolve()
        await vi.waitFor(() => expect(starts()).toHaveLength(1))
        expect(replacement.phase).toBe('ready')
        expect(starts()[0]?.params).toMatchObject({
          clientUserMessageId: id,
          input: [{ type: 'text', text: 'same original input' }],
          personality: 'friendly',
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'readOnly' }
        })
        turns.start()
        turns.echo(id)
        const answered = current().submission((await waiting)?.value)
        expect(answered).toMatchObject({
          clientMessageId: id,
          dispatchState: 'accepted',
          fence: replacement.fence,
          options: { personality: 'friendly' }
        })
        expect(answered).toEqual(journal.submission(id))
        expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(originalBody)
        await current().waitForInputFinalization(journal, id)
        expect(signals.every((observed) => observed === originalSignal)).toBe(true)
        expect(originalSignal?.aborted).toBe(false)
        expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
        expect(starts()).toHaveLength(1)
        expect(codex.connections).toHaveLength(3)
        return
      }
      stopping = closing ? host.close(SESSION, 'user-close') : stop()
      expect(signal?.aborted).toBe(true)
      expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
      const rowFence = journal.submission(id)!.fence
      held.resolve()
      retryReady.resolve()
      await stopping
      await drainForwarded()
      await current().waitForInputFinalization(journal, id)
      await journal['queue'].drain()
      if (closing) {
        const row = journal.submission(id)
        const cards = journal.queuedMessages.list()
        expect(rowFence).toBe(original.fence)
        expect(boundFence).toBe(original.fence + 2)
        expect(starts()).toHaveLength(0)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)
        expect(cards.map((card) => card.messageId)).toEqual([id])
        expect(current().submission((await waiting)?.value)).toEqual(row)
        expect(cards[0]).toMatchObject({
          body: originalBody,
          options: { personality: 'friendly' },
          position: 0
        })
        expect(row).toMatchObject({
          keptAsQueuedMessageId: id,
          source: { kind: 'user' },
          rejection: { kind: 'chatClosed' }
        })
        return
      }
      expect(journal.submission(id)).toMatchObject({
        clientMessageId: id,
        dispatchState: 'rejected',
        fence: settlesAtChildFence ? boundFence : current().conversationFence(),
        rejection: { kind: 'cancelled' },
        options: { personality: 'friendly' }
      })
      if (boundary === 'retire') {
        expect(current().conversationFence()).toBe(boundFence + 1)
        expect(rebound.mock.calls).toContainEqual([
          expect.objectContaining({
            clientMessageId: id,
            state: 'rejected',
            fence: current().conversationFence()
          })
        ])
      }
      expect(current().submission((await waiting)?.value)).toEqual(journal.submission(id))
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(originalBody)
      expect(journal.submission(id)?.reason).toMatch(/provider_cancelled_before_start/)
      expect(journal.submission(id)?.rejection).not.toHaveProperty('neverReachedAgent')
      expect(starts()).toHaveLength(0)
      expect(codex.connections).toHaveLength(boundary === 'retire' ? 1 : 2)
      const next = await permissionSend('new question after Stop')
      await vi.waitFor(() => expect(starts()).toHaveLength(1))
      expect(starts()[0]?.params).toMatchObject({
        clientUserMessageId: next,
        input: [{ type: 'text', text: 'new question after Stop' }]
      })
      turns.start()
      turns.echo(next)
      expect(
        current().submission((await host.waitForSendSettlement(SESSION, next))?.value)
      ).toMatchObject({ clientMessageId: next, dispatchState: 'accepted' })
      expect(journal.stoppedHistoryCarried().get(next) ?? []).toEqual([])
      await current().waitForInputFinalization(journal, next)
    } finally {
      held.resolve()
      retryReady.resolve()
      await stopping
      await drainForwarded()
      await current().waitForInputFinalization(journal, id)
      const writes = await Promise.allSettled(rebound.mock.results.map((result) => result.value))
      expect(writes.filter((result) => result.status === 'rejected')).toEqual([])
      vi.restoreAllMocks()
    }
  })
}
