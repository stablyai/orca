import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { expect, it, vi } from 'vitest'
import '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from '../../delivery/structured-agent-session-handing-over'
import '../../providers/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../../providers/structured-agent-session-adapter-errors'
import { CodexAppServerRequestError } from '../../../../codex/app-server/codex-app-server-request-error'
import { CodexAppServerTimeoutError } from '../../../../codex/app-server/codex-app-server-session'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import '../../startup/structured-agent-session-agent-start'
import '../structured-agent-session-conversation-open'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import '../../termination/structured-agent-session-host-lifetime'

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
      expect(await row(id)).toMatchObject({ dispatchState: 'unknown' })
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
      expect((await row(id))?.dispatchState).toBe(written ? 'unknown' : 'rejected')
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
    const retire = deps.stopPermissionTransitionChild!
    const retired = vi
      .spyOn(deps, 'stopPermissionTransitionChild')
      .mockImplementation(async (...args) => {
        if (
          boundary === 'retire' &&
          journal
            .submissions()
            .some((s) => continuingStructuredAgentSessionInput(journal, s.clientMessageId))
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
        fence: current().conversationFence(),
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
