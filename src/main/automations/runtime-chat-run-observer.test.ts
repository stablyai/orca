import './automation-chat-run-measurement-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { chatAutomationRunObservation, observeAutomationChatRun } from './runtime-chat-run-observer'
import type { JournalPublication } from '../native-chat/agent-session-wire/host/structured-agent-session-conversations'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import '../../shared/agent-session/journal/agent-session-journal-types'
import { automationRunOperationId } from './automation-run-operation'

const mocks = vi.hoisted(() => {
  const hostState: { actualHost: StructuredAgentSessionHost | null } = { actualHost: null }
  return {
    ...hostState,
    host: {
      journalCurrentRead: vi.fn(),
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
      expect(mocks.host.journalCurrentRead).not.toHaveBeenCalled()
      observer.next({ kind: 'reset', source: {}, journal: null })
      return release
    })
    mocks.host.journalCurrentRead.mockReturnValue(read.promise)
    const controller = new AbortController()
    const pending = observeAutomationChatRun(runtime, run, controller.signal)
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.waitFor(() => expect(mocks.host.journalCurrentRead).toHaveBeenCalledOnce())
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
    mocks.host.journalCurrentRead.mockReturnValueOnce(opening.promise).mockResolvedValue(view)
    mocks.host.queuedSendAnswer.mockReturnValueOnce(delayed.promise)
    const pending = observeAutomationChatRun(runtime, run, new AbortController().signal)
    await vi.waitFor(() => expect(mocks.host.journalCurrentRead).toHaveBeenCalledOnce())
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
    expect(mocks.host.journalCurrentRead).toHaveBeenCalledTimes(3)
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
      mocks.host.journalCurrentRead.mockImplementation(async () => {
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
