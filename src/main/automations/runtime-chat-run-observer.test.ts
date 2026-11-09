import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  agentJournalItemKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { chatAutomationRunObservation, observeAutomationChatRun } from './runtime-chat-run-observer'
import type { JournalPublication } from '../native-chat/agent-session-wire/host/structured-agent-session-conversations'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { automationRunOperationId } from './automation-run-operation'

const mocks = vi.hoisted(() => {
  const hostState: { actualHost: StructuredAgentSessionHost | null } = { actualHost: null }
  return {
    ...hostState,
    host: {
      automationRun: vi.fn(),
      observeConversationPublications: vi.fn(),
      queuedSendAnswer: vi.fn(async () => null)
    }
  }
})
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
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

describe('restart observation and disposal', () => {
  function fixture() {
    const run = {
      ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
      // ast-grep-ignore: test-no-wall-clock -- Run timestamps must match the live host expiry clock.
      createdAt: Date.now(),
      // ast-grep-ignore: test-no-wall-clock -- Run timestamps must match the live host expiry clock.
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
      expect(mocks.host.automationRun).not.toHaveBeenCalled()
      observer.next({ kind: 'reset', source: {}, journal: null })
      return release
    })
    mocks.host.automationRun.mockReturnValue(read.promise)
    const controller = new AbortController()
    const pending = observeAutomationChatRun(runtime, run, controller.signal)
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.waitFor(() => expect(mocks.host.automationRun).toHaveBeenCalledOnce())
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
    mocks.host.automationRun.mockReturnValueOnce(opening.promise).mockResolvedValue(view)
    mocks.host.queuedSendAnswer.mockReturnValueOnce(delayed.promise)
    const pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
    await vi.waitFor(() => expect(mocks.host.automationRun).toHaveBeenCalledOnce())
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
    expect(mocks.host.automationRun).toHaveBeenCalledTimes(3)
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('real host queue publication', () => {
  it('follows a queued run through handover and returns its exact output', async () => {
    const rig = await createQueuedMessageTestRig({ restartable: true })
    mocks.actualHost = rig.host
    const controller = new AbortController()
    try {
      const working = await rig.workingSend()
      const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
      const run = {
        ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
        // ast-grep-ignore: test-no-wall-clock -- Match the observer's expiry clock.
        createdAt: Date.now(),
        // ast-grep-ignore: test-no-wall-clock -- Match the observer's expiry clock.
        dispatchedAt: Date.now(),
        sessionKind: 'chat' as const,
        chatSessionId: HOST_TEST_SESSION
      }
      const q = automationRunOperationId(run, 'reuse-send')
      const fields = {
        body: hostTestMessage('automation behind human backlog'),
        delivery: 'queue-if-active' as const
      }
      expect(
        await rig.host.send(
          { callerKey: 'client-1' },
          {
            ...fields,
            envelope: rig.envelope(fields, 'agentSession.send', q)
          }
        )
      ).toMatchObject({ ok: true, value: { queued: { messageId: q, state: 'waiting' } } })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only runtime initialization and receipt lookup are scripted; the host owns delivery and observation.
      const runtime = {
        ensureStructuredAgentSessionHost: async () => {},
        openAgentSessionRecordStore: async () => ({
          getOperationRow: (_caller: string, id: string) =>
            id === q
              ? { outcome: { status: 'succeeded', sessionId: HOST_TEST_SESSION } }
              : undefined,
          getConversation: () => ({ provider: 'codex', location: { workspaceId: 'workspace-1' } })
        })
      } as unknown as OrcaRuntimeService
      const pending = observeAutomationChatRun(runtime, run, controller.signal)
      void pending.catch(() => {})
      await rig.settleAccepted(working, 'human')
      let sink = rig.providerEvents()
      sink.appendItem(
        { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-human', ordinal: 1 },
        { kind: 'turn', turnId: 'turn-human', state: 'completed', outcome: 'success' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
      sink.publish({ lifecycle: true })
      expect(await sink.written?.()).toEqual({ ok: true })
      await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
      const sent = await rig.handoffId(q)
      expect(sent).not.toBe(q)
      await eventually(async () =>
        expect((await journal.reads.submission(sent))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(sent, 'automation')
      const accepted = await journal.reads.submission(sent)
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
      expect(await pending).toMatchObject({
        status: 'completed',
        outputSnapshot: { content: 'Exact automation output' }
      })
      expect(rig.dispatch).toHaveBeenCalledTimes(2)
    } finally {
      controller.abort()
      mocks.actualHost = null
      await rig.dispose()
    }
  })
  it.each(['withdraw', 'return', 'missing', 'end'] as const)(
    'settles a queue-only %s without resending',
    async (outcome) => {
      const rig = await createQueuedMessageTestRig({
        idleSweep: { idleMs: () => 0, intervalMs: 3600000 }
      })
      mocks.actualHost = rig.host
      try {
        const working = await rig.workingSend()
        const run = {
          ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
          // ast-grep-ignore: test-no-wall-clock -- Run timestamps must match the live host expiry clock.
          createdAt: Date.now(),
          // ast-grep-ignore: test-no-wall-clock -- Run timestamps must match the live host expiry clock.
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
        const reads = vi.spyOn(rig.host, 'automationRun')
        await eventually(() => expect(reads).toHaveBeenCalled())

        expect(
          chatAutomationRunObservation(
            await rig.host.automationRun(HOST_TEST_SESSION, q, []),
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
            await rig.host.automationRun(HOST_TEST_SESSION, q, []),
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
            await rig.host.automationRun(HOST_TEST_SESSION, q, []),
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
