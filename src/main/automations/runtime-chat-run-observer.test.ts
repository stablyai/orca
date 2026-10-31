import { measureAutomationChatRun } from './automation-chat-run-measurement-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  agentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { chatAutomationRunObservation, observeAutomationChatRun } from './runtime-chat-run-observer'
import type { JournalPublication } from '../native-chat/agent-session-wire/structured-agent-session-conversations'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  createQueuedMessageTestRig,
  eventually
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { automationRunOperationId } from './automation-run-operation'

const mocks = vi.hoisted(() => {
  const hostState: { actualHost: StructuredAgentSessionHost | null } = { actualHost: null }
  return {
    ...hostState,
    host: {
      journalSnapshot: vi.fn(),
      observeConversationPublications: vi.fn(),
      queuedSendAnswer: vi.fn(async () => null)
    }
  }
})
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.actualHost ?? mocks.host
}))
const submission: AgentJournalSubmission = {
  clientMessageId: 'prompt',
  fence: 1,
  payloadFingerprint: 'hash',
  dispatchState: 'accepted',
  providerItemId: 'provider-user',
  reason: null,
  submittedAt: 1,
  resolvedAt: 2
}
function turn(
  itemId: string,
  userItemId: string,
  state: 'running' | 'completed' | 'interrupted' = 'completed'
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'turn',
      turnId: itemId,
      userItemId,
      state,
      ...(state === 'completed' ? { outcome: 'success' as const } : {})
    }
  }
}
function answer(itemId: string, turnItemId: string, text: string): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'turn', turnItemId },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}
function snapshot(items: AgentJournalRenderItem[] = []): AgentJournalSnapshot {
  return {
    sessionId: 'claude_chat',
    cursor: { epoch: 'epoch', sequence: 2 },
    items,
    submissions: [submission]
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualHost = null
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
describe('exact automation chat turn', () => {
  it('waits for its own prompt even when a later human turn completed', () => {
    expect(
      chatAutomationRunObservation(
        snapshot([turn('own', 'provider-user', 'running'), turn('human', 'other')]),
        'prompt',
        'Claude'
      )
    ).toBeNull()
    const missingRoot = snapshot([turn('human', 'other')])
    const roots = vi.spyOn(missingRoot.items, 'find')
    expect(chatAutomationRunObservation(missingRoot, 'prompt', 'Claude')).toBeNull()
    expect(roots).toHaveBeenCalledOnce()
    missingRoot.submissions = []
    roots.mockClear()
    expect(chatAutomationRunObservation(missingRoot, 'prompt', 'Claude')).toBeNull()
    expect(roots).not.toHaveBeenCalled()
  })
  it('matches the Orca opener alias and snapshots only the accepted root turn', () => {
    const view = snapshot([
      turn('own', agentJournalSubmissionKey('prompt')),
      answer('a', 'own', 'Automation output'),
      answer('b', 'human', 'Private later output'),
      { ...answer('c', 'own', 'Child output'), agentId: 'child' }
    ])
    let outputRows = 0
    const items = view.items[Symbol.iterator].bind(view.items)
    vi.spyOn(view.items, Symbol.iterator).mockImplementation(function* () {
      for (const item of items()) {
        outputRows++
        yield item
      }
      return undefined
    })
    const result = chatAutomationRunObservation(view, 'prompt', 'Codex')
    expect(outputRows).toBe(4)
    expect(result).toMatchObject({
      status: 'completed',
      error: null,
      outputSnapshot: { content: 'Automation output' }
    })
  })
  it('accepts explicit start proof and never claims a steered or unlinked turn', () => {
    const view = snapshot([turn('own', 'different')])
    view.submissions = [{ ...submission, answeredInTurn: { turnItemId: 'own', via: 'steer' } }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Codex')).toBeNull()
    view.submissions = [{ ...submission, answeredInTurn: { turnItemId: 'own', via: 'start' } }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Codex')?.status).toBe('completed')
  })
  it('reports Stop as Interrupted and unknown or refused prompts as failures', () => {
    expect(
      chatAutomationRunObservation(
        snapshot([turn('own', 'provider-user', 'interrupted')]),
        'prompt',
        'Claude'
      )
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('Interrupted') })
    const view = snapshot()
    view.submissions = [{ ...submission, dispatchState: 'unknown' }]
    expect(chatAutomationRunObservation(view, 'prompt', 'Claude')).toMatchObject({
      status: 'dispatch_failed',
      error: expect.stringContaining('Claude')
    })
  })
  it('does not infer success from completed without an outcome and bounds output', () => {
    const own = turn('own', 'provider-user')
    own.body = { kind: 'turn', turnId: 'own', userItemId: 'provider-user', state: 'completed' }
    const result = chatAutomationRunObservation(
      snapshot([own, answer('a', 'own', 'x'.repeat(300_000))]),
      'prompt',
      'Claude'
    )
    expect(result?.status).toBe('dispatch_failed')
    expect(result?.outputSnapshot?.content.length).toBeLessThanOrEqual(256 * 1024)
    expect(result?.outputSnapshot?.truncated).toBe(true)
  })
})

describe('restart observation and disposal', () => {
  function fixture() {
    const run = {
      ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
      createdAt: Date.now(),
      dispatchedAt: Date.now(),
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_chat'
    }
    const messageId = automationRunOperationId(run, 'reuse-send')
    const records = {
      getOperationRow: vi.fn((_caller: string, id: string) =>
        id === messageId
          ? { outcome: { status: 'succeeded', sessionId: 'claude_chat' } }
          : undefined
      ),
      getConversation: () => ({
        sessionId: 'claude_chat',
        provider: 'claude',
        location: { workspaceId: 'wt-1' }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: observation reaches only these two runtime boundaries.
    const runtime = {
      ensureStructuredAgentSessionHost: vi.fn(),
      openAgentSessionRecordStore: async () => records
    } as unknown as OrcaRuntimeService
    const view = snapshot([turn('own', agentJournalSubmissionKey(messageId), 'running')])
    view.submissions = [{ ...submission, clientMessageId: messageId }]
    return { run, records, runtime, view }
  }
  it('registers synchronously before read and abort wins over a late read', async () => {
    const { run, runtime, view } = fixture()
    const release = vi.fn()
    const read = Promise.withResolvers<AgentJournalSnapshot>()
    mocks.host.observeConversationPublications.mockImplementation((_id, observer) => {
      expect(mocks.host.journalSnapshot).not.toHaveBeenCalled()
      observer.next({ kind: 'reset', source: {}, journal: null })
      return release
    })
    mocks.host.journalSnapshot.mockReturnValue(read.promise)
    const controller = new AbortController()
    const pending = observeAutomationChatRun(runtime, run, controller.signal)
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.waitFor(() => expect(mocks.host.journalSnapshot).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    read.resolve(view)
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.host.queuedSendAnswer).not.toHaveBeenCalled()
  })
  it('fences replacement and row-free changes across both awaits without losing exact completion', async () => {
    const { run, runtime, view } = fixture()
    const release = vi.fn()
    const source = {}
    let notify: (hint: JournalPublication) => void = () => {}
    mocks.host.observeConversationPublications.mockImplementation((_id, observer) => {
      notify = observer.next
      notify({ kind: 'reset', source, journal: null })
      return release
    })
    const delayed = Promise.withResolvers<null>()
    const opening = Promise.withResolvers<AgentJournalSnapshot>()
    mocks.host.journalSnapshot.mockReturnValueOnce(opening.promise).mockResolvedValue(view)
    mocks.host.queuedSendAnswer.mockReturnValueOnce(delayed.promise)
    const pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
    await vi.waitFor(() => expect(mocks.host.journalSnapshot).toHaveBeenCalledOnce())
    notify({ kind: 'reset', source: {}, journal: null })
    opening.resolve({
      ...view,
      items: [turn('old-completed', view.submissions[0].providerItemId!)]
    })
    await vi.waitFor(() => expect(mocks.host.queuedSendAnswer).toHaveBeenCalledOnce())
    notify({ kind: 'operational', source, journal: null })
    view.items[0] = turn('own', view.submissions[0].providerItemId!)
    delayed.resolve(null)
    expect(await pending).toMatchObject({ status: 'completed' })
    expect(mocks.host.journalSnapshot).toHaveBeenCalledTimes(3)
    expect(release).toHaveBeenCalledOnce()
  })
  it('ends read errors, listener errors, host-end and the six-hour deadline exactly once', async () => {
    vi.useFakeTimers()
    const { run, runtime, view } = fixture()
    for (const mode of ['read', 'listener', 'end', 'deadline'] as const) {
      const release = vi.fn()
      let observer:
        | { next: (hint: JournalPublication) => void; error: (error: unknown) => void }
        | undefined
      mocks.host.observeConversationPublications.mockImplementation((_id, next) => {
        observer = next
        next.next({ kind: 'reset', source: {}, journal: null })
        return release
      })
      mocks.host.journalSnapshot.mockImplementation(async () => {
        if (mode === 'read') {
          throw new Error('unreadable')
        }
        return view
      })
      const pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
      const result = pending.then(
        (value) => value,
        (error) => error
      )
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'listener') {
        observer!.error(new Error('consumer'))
      }
      if (mode === 'end') {
        observer!.next({ kind: 'end', source: null, journal: null })
      }
      if (mode === 'deadline') {
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      }
      expect(await result).toMatchObject(
        mode === 'deadline'
          ? { status: 'dispatch_failed' }
          : {
              message:
                mode === 'read'
                  ? 'unreadable'
                  : mode === 'listener'
                    ? 'consumer'
                    : 'Chat session host stopped'
            }
      )
      observer!.next({ kind: 'reset', source: {}, journal: null })
      expect(release).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('fails promptly when no exact accepted receipt survives', async () => {
    const { run, runtime, records } = fixture()
    records.getOperationRow.mockReturnValue(undefined)
    expect(
      await observeAutomationChatRun(runtime, run, new AbortController().signal)
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('confirm') })
    expect(mocks.host.observeConversationPublications).not.toHaveBeenCalled()
  })
})

// The provider is scripted; queue ownership, journal, catch-up and publication are real.
describe('real host queue publication and operation bounds', () => {
  it.each([100, 1000])(
    'observes Q→S at %i prior turns without token-triggered history scans',
    async (history) => {
      const totals: number[][] = []
      for (const mode of ['baseline', 'internal', 'display'] as const) {
        const rig = await createQueuedMessageTestRig({ restartable: true })
        mocks.actualHost = rig.host
        const controller = new AbortController()
        try {
          const working = await rig.workingSend()
          let sink = rig.providerEvents()
          const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
          for (let n = 0; n < history; n++) {
            await journal.appendSubmission({
              clientMessageId: `old-send-${n}`,
              payloadFingerprint: 'a'.repeat(64),
              fence: 1,
              body: hostTestMessage(`old prompt ${n}`)
            })
            await journal.resolveDispatch({
              clientMessageId: `old-send-${n}`,
              state: 'accepted',
              providerIdentity: null,
              fence: 1
            })
            sink.appendItem(
              { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: `old-${n}`, ordinal: 0 },
              { kind: 'turn', turnId: `old-${n}`, state: 'completed', outcome: 'success' },
              { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
            )
            if (n % 100 === 99) {
              await sink.written?.()
            }
          }
          await sink.written?.()
          const run = {
            ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
            createdAt: Date.now(),
            dispatchedAt: Date.now(),
            sessionKind: 'chat' as const,
            chatSessionId: HOST_TEST_SESSION
          }
          const q = automationRunOperationId(run, 'reuse-send')
          const body = hostTestMessage('automation behind human backlog')
          const fields = { body, delivery: 'queue-if-active' as const }
          expect(
            await rig.host.send(
              { callerKey: 'client-1' },
              {
                ...fields,
                envelope: rig.envelope(fields, 'agentSession.send', q)
              }
            )
          ).toMatchObject({ ok: true, value: { queued: { messageId: q, state: 'waiting' } } })
          const metrics = measureAutomationChatRun(journal, rig.host)
          const { measure, full, observerReads, registration, releases, keys, timers, cleared } =
            metrics
          const tokenBurst = async () => {
            for (let n = 0; n < 25; n++) {
              sink.appendItem(
                { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'unrelated', ordinal: 1 },
                {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: `token-${n}` }]
                },
                { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
              )
              sink.publish()
              await sink.written?.()
              await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
            }
          }
          const difference = (before: number[]) =>
            measure().map((value, index) => value - before[index])
          const displayRelease =
            mode === 'display'
              ? await rig.host.subscribe({
                  id: 'ordinary-display',
                  sessionId: HOST_TEST_SESSION,
                  emit: () => {}
                })
              : () => {}
          const beforeBaseline = measure()
          await tokenBurst()
          const baselineWork = difference(beforeBaseline)
          const runtimeFacade = {
            ensureStructuredAgentSessionHost: async () => {},
            openAgentSessionRecordStore: async () => ({
              getOperationRow: (_caller: string, id: string) =>
                id === q
                  ? { outcome: { status: 'succeeded', sessionId: HOST_TEST_SESSION } }
                  : undefined,
              getConversation: () => ({
                provider: 'codex',
                location: { workspaceId: 'workspace-1' }
              })
            })
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: initialization/receipt reads are scripted; the actual host/journal/queue/observer and N/10N measurements execute.
          const runtime = runtimeFacade as unknown as OrcaRuntimeService
          let pending =
            mode === 'internal' ? observeAutomationChatRun(runtime, run, controller.signal) : null
          void pending?.catch(() => {})
          if (pending) {
            await eventually(() => expect(registration).toHaveBeenCalledOnce())
          }
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          await eventually(() => expect(full.mock.calls.length).toBeGreaterThan(0))
          const beforeTokens = measure()
          const readsBeforeTokens = observerReads.mock.calls.length
          const keysBeforeTokens = keys.map((spy) => spy.mock.calls.length)
          await tokenBurst()
          expect(observerReads.mock.calls.length).toBe(readsBeforeTokens)
          const observerWork = difference(beforeTokens)
          expect(observerWork).toEqual(baselineWork)
          const keyedAdded = keys.map((spy, i) => spy.mock.calls.length - keysBeforeTokens[i])
          expect(keyedAdded.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25 * 12)
          const unchangedReads = observerReads.mock.calls.length
          await journal.resolveDispatch({
            clientMessageId: 'old-send-0',
            state: 'accepted',
            providerIdentity: null,
            fence: 1
          })
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          expect(observerReads).toHaveBeenCalledTimes(unchangedReads)
          if (pending) {
            controller.abort()
            await expect(pending).rejects.toThrow('request_aborted')
            expect(releases[0]).toHaveBeenCalledOnce()
            pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
            await eventually(() => expect(registration).toHaveBeenCalledTimes(2))
          }
          await rig.settleAccepted(working, 'human')
          sink.appendItem(
            { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-human', ordinal: 1 },
            { kind: 'turn', turnId: 'turn-human', state: 'completed', outcome: 'success' },
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
          )
          sink.publish({ lifecycle: true })
          expect(await sink.written?.()).toEqual({ ok: true })
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          const handoff = () =>
            journal.submissions().findLast((entry) => entry.queuedMessageId === q)
          await eventually(() => expect(handoff()).toBeDefined())
          const sent = handoff()!.clientMessageId
          expect(sent).not.toBe(q)
          await eventually(() => expect(journal.submission(sent)?.handedOverAt).toBeDefined())
          await rig.settleAccepted(sent, 'automation')
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          const beforeRestatement = observerReads.mock.calls.length
          await journal.resolveDispatch({
            clientMessageId: sent,
            state: 'accepted',
            providerIdentity: null,
            fence: 1
          })
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          expect(observerReads).toHaveBeenCalledTimes(beforeRestatement)
          const beforeWork = observerReads.mock.calls.length
          rig.host['clientDelivery'].publishRestored(HOST_TEST_SESSION)
          rig.host.publishWorkChanged(HOST_TEST_SESSION)
          if (pending) {
            await eventually(() =>
              expect(observerReads.mock.calls.length).toBeGreaterThan(beforeWork)
            )
          }
          const accepted = journal.submission(sent)
          sink = rig.providerEvents()
          const ownId = {
            provider: 'codex' as const,
            threadId: HOST_TEST_THREAD,
            turnId: 'turn-automation',
            ordinal: 1
          }
          sink.appendItem(
            ownId,
            {
              kind: 'turn',
              turnId: 'turn-automation',
              userItemId: accepted!.providerItemId!,
              state: 'completed',
              outcome: 'success'
            },
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
          )
          sink.appendItem(
            { ...ownId, ordinal: 2 },
            {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Exact automation output' }]
            },
            { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(ownId) } }
          )
          sink.publish({ lifecycle: true })
          expect(await sink.written?.()).toEqual({ ok: true })
          await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
          expect(
            pending
              ? await pending
              : chatAutomationRunObservation(
                  await rig.host.journalSnapshot(HOST_TEST_SESSION),
                  q,
                  'Codex',
                  await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
                )
          ).toMatchObject({
            status: 'completed',
            outputSnapshot: { content: 'Exact automation output' }
          })
          expect(rig.dispatch).toHaveBeenCalledTimes(2)
          expect(releases).toHaveLength(mode === 'internal' ? 2 : 0)
          for (const release of releases) {
            expect(release).toHaveBeenCalledOnce()
          }
          for (const [index, args] of timers.mock.calls.entries()) {
            if (Number(args[1]) > 5 * 60 * 60 * 1000) {
              expect(cleared).toHaveBeenCalledWith(timers.mock.results[index].value)
            }
          }
          displayRelease()
          expect(registration).toHaveBeenCalledTimes(mode === 'internal' ? 2 : 0)
          expect(observerReads.mock.calls.length).toBeLessThanOrEqual(12)
          const { copied, iteratorYields, projectedRows, scannedRows } = metrics.details()
          expect(copied + iteratorYields + projectedRows + scannedRows).toBeLessThan(
            (history + 30) * 4000
          )
          const sessions = rig.host.collaboratorsForTests().sessions
          expect(sessions['observers'].size).toBe(0)
          expect(sessions['attachments'].size).toBe(1)
          totals.push(measure())
          process.stdout.write(
            `${JSON.stringify({ history, mode, sourceAttachments: sessions['attachments'].size, logicalObservers: sessions['observers'].size, baselineWork, observerWork, keyedAdded, totals: measure(), ...metrics.details(), reconciliations: observerReads.mock.calls.length, registrations: registration.mock.calls.length, releases: releases.filter((r) => r.mock.calls.length === 1).length })}\n`
          )
        } finally {
          controller.abort()
          mocks.actualHost = null
          await rig.dispose()
          vi.restoreAllMocks()
        }
      }
      const added = totals[1].map((value, i) => value - totals[0][i])
      expect(added.slice(0, 15).filter((_, i) => i !== 5 && i !== 12)).toEqual(
        added
          .slice(0, 15)
          .filter((_, i) => i !== 5 && i !== 12)
          .map(() => 0)
      )
      expect(added[5]).toBe(6)
      expect(added[12]).toBe(6)
      expect(totals[0].slice(17, 21)).toEqual([1, 2 * history + 5, 0, 0])
      expect(totals[1].slice(17, 21)).toEqual([5, 10 * history + 20, 2, 2 * history + 2])
      expect(added.slice(15)).toEqual([
        8 * history + 15,
        2 * history + 2,
        4,
        8 * history + 15,
        2,
        2 * history + 2,
        0
      ])
      process.stdout.write(
        `${JSON.stringify({ history, fullWorkloadBaseline: totals[0], fullWorkloadInternal: totals[1], added, displayControl: totals[2] })}\n`
      )
    }
  )
  it.each(['withdraw', 'return', 'missing', 'end'] as const)(
    'settles a queue-only %s without resending',
    async (outcome) => {
      const rig = await createQueuedMessageTestRig({
        idleSweep: { idleMs: 0, intervalMs: 3600000 }
      })
      mocks.actualHost = rig.host
      try {
        const working = await rig.workingSend()
        const run = {
          ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
          createdAt: Date.now(),
          dispatchedAt: Date.now(),
          chatSessionId: HOST_TEST_SESSION
        }
        const q = automationRunOperationId(run, 'reuse-send')
        const fields = { body: hostTestMessage('queued'), delivery: 'queue-if-active' as const }
        await rig.host.send(
          { callerKey: 'client-1' },
          { ...fields, envelope: rig.envelope(fields, 'agentSession.send', q) }
        )
        const runtime = {
          ensureStructuredAgentSessionHost: async () => {},
          openAgentSessionRecordStore: async () => ({
            getOperationRow: (_caller: string, id: string) =>
              id === automationRunOperationId(run, 'reuse-send')
                ? { outcome: { status: 'succeeded', sessionId: HOST_TEST_SESSION } }
                : undefined,
            getConversation: () => ({ provider: 'codex', location: { workspaceId: 'workspace-1' } })
          })
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: initialization/receipt reads are scripted; the actual host/journal/queue/observer and eviction/reopen lifecycle execute.
        const typedRuntime = runtime as unknown as OrcaRuntimeService
        const live = observeAutomationChatRun(typedRuntime, run, new AbortController().signal)
        const liveResult = live.then(
          (value) => value,
          (error) => error
        )
        const reads = vi.spyOn(rig.host, 'journalSnapshot')
        await eventually(() => expect(reads).toHaveBeenCalled())

        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toBeNull()
        await rig.stop()
        await rig.settleAccepted(working, 'stopped')
        const starts = rig.starts.mock.calls.length,
          sends = rig.dispatch.mock.calls.length
        const { sessions, lifetime, serialize } = rig.host.collaboratorsForTests()
        const old = sessions.get(HOST_TEST_SESSION)!.journal
        await lifetime.idleSweep.tick()
        expect(rig.closeSession).toHaveBeenCalledOnce()
        expect(sessions.get(HOST_TEST_SESSION)?.journal).toBe(old)
        await serialize(HOST_TEST_SESSION, async () => {
          sessions.delete(HOST_TEST_SESSION)
          await old.close()
        })
        await eventually(() => expect(sessions.get(HOST_TEST_SESSION)?.journal).not.toBe(old))
        await eventually(async () =>
          expect(await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)).toMatchObject({
            queued: { state: 'waiting' }
          })
        )
        const cached = sessions.get(HOST_TEST_SESSION)!.journal
        await serialize(HOST_TEST_SESSION, async () => {
          sessions.clear()
          await cached.close()
        })
        await eventually(() => expect(sessions.has(HOST_TEST_SESSION)).toBe(true))
        expect(rig.starts).toHaveBeenCalledTimes(starts)
        expect(rig.dispatch).toHaveBeenCalledTimes(sends)
        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toBeNull()
        if (outcome === 'missing' || outcome === 'end') {
          if (outcome === 'missing') {
            await rig.store['transact']((draft) => draft.records.delete(HOST_TEST_SESSION))
            sessions.delete(HOST_TEST_SESSION)
          } else {
            rig.host.stopDelivery()
          }
          expect(await liveResult).toBeInstanceOf(Error)
          expect(sessions['observers'].size).toBe(0)
          return
        }
        if (outcome === 'withdraw') {
          await rig.deleteQueued(q)
        } else {
          await rig.stop()
          await rig.sendNow(q)
          const handoff = await rig.handoffId(q)
          await rig.settleRejected(handoff, 'provider refused')
        }
        expect(
          chatAutomationRunObservation(
            await rig.host.journalSnapshot(HOST_TEST_SESSION),
            q,
            'Codex',
            await rig.host.queuedSendAnswer(HOST_TEST_SESSION, q)
          )
        ).toMatchObject({ status: 'dispatch_failed' })
        expect(await liveResult).toMatchObject({ status: 'dispatch_failed' })
        expect(run.chatSessionId).toBe(HOST_TEST_SESSION)
      } finally {
        mocks.actualHost = null
        await rig.dispose()
      }
    }
  )
})
