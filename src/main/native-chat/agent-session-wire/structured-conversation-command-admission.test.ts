import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

function snapshot(items: AgentJournalSnapshot['items'] = []): AgentJournalSnapshot {
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: 0 },
    items,
    submissions: []
  }
}

function contextWith(
  backgroundTasks: AgentSessionBackgroundTaskState | null,
  submissions: AgentJournalSubmission[] = []
): Parameters<typeof conversationCommandBlocked>[0] {
  return {
    sessionId: 'session-1',
    fence: 1,
    journal: {
      snapshot: () => snapshot(),
      submissions: () => submissions
    },
    adapter: { backgroundTaskState: () => backgroundTasks }
  }
}

const RECORD = { lease: {} } as unknown as AgentSessionRecord

function submission(
  dispatchState: AgentJournalSubmission['dispatchState'],
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: 'message-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 2,
    ...overrides
  }
}

describe('conversationCommandBlocked background tasks', () => {
  it('admits the command when nothing is being monitored', () => {
    expect(conversationCommandBlocked(contextWith(null), RECORD)).toBeNull()
  })

  it('asks for a stop when the host accepts targeted stops', () => {
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsTaskStop: true }),
      RECORD
    )
    expect(blocked).toBe('Stop background tasks before using this command.')
  })

  it('asks for a stop on a host that predates the stop-capability field', () => {
    const blocked = conversationCommandBlocked(contextWith({ state: 'monitoring' }), RECORD)
    expect(blocked).toBe('Stop background tasks before using this command.')
  })

  it('asks the user to wait when the provider exposes no stop at all', () => {
    // Codex: an instruction to stop would name a control that does not exist.
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsStopAll: false }),
      RECORD
    )
    expect(blocked).toBe('Wait for background tasks to finish before using this command.')
  })

  it('still refuses on the open turn, not on the work the strip now shows', () => {
    // The strip reports subagents while a turn runs. That must not change which
    // refusal the user sees: an open turn already refuses, and it refuses first,
    // so a live fan-out never re-labels the reason or blocks anything new.
    const ctx = contextWith({ state: 'monitoring', supportsTaskStop: true })
    ctx.journal.snapshot = () =>
      snapshot([
        {
          itemId: 'turn-1',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'status',
            text: 'Working',
            turnLifecycle: { turnId: 'turn-1', state: 'running' }
          }
        }
      ])
    expect(conversationCommandBlocked(ctx, RECORD)).toBe(
      'Wait for the current turn to finish before using this command.'
    )
  })
})

describe('conversationCommandBlocked dispatch ownership', () => {
  it.each(['pending', 'unknown'] as const)('blocks a live %s dispatch', (dispatchState) => {
    expect(conversationCommandBlocked(contextWith(null, [submission(dispatchState)]), RECORD)).toBe(
      'Resolve pending or unconfirmed messages before using this command.'
    )
  })

  it('admits a command after turn settlement retires an unconfirmed dispatch', () => {
    const retired = submission('unknown', {
      reason: 'turn_settled_before_acknowledgement',
      recovered: true
    })

    expect(conversationCommandBlocked(contextWith(null, [retired]), RECORD)).toBeNull()
  })

  it('does not let an unanswered dispatch from an older owner block the current fence', () => {
    expect(
      conversationCommandBlocked(contextWith(null, [submission('pending', { fence: 0 })]), RECORD)
    ).toBeNull()
  })
})
