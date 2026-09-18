import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import { DISPATCH_DOUBT_HOST_RESTARTED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

const CURRENT_FENCE = 4

function contextWith(
  backgroundTasks: AgentSessionBackgroundTaskState | null
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal: {
      snapshot: () => ({ items: [] }),
      submissions: () => []
    },
    adapter: { backgroundTaskState: () => backgroundTasks }
  } as unknown as AgentSessionTurnContext
}

function contextHolding(submissions: AgentJournalSubmission[]): AgentSessionTurnContext {
  const ctx = contextWith(null)
  ctx.fence = CURRENT_FENCE
  ctx.journal.submissions = () => submissions
  return ctx
}

function submission(
  dispatchState: AgentJournalSubmission['dispatchState'],
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: 'm1',
    fence: CURRENT_FENCE,
    payloadFingerprint: 'm1',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 2,
    ...overrides
  }
}

const RECORD = { lease: {} } as unknown as AgentSessionRecord
const UNSETTLED_REFUSAL = 'Resolve pending or unconfirmed messages before using this command.'

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
      ({
        items: [
          {
            id: 'turn-1',
            body: {
              kind: 'status',
              turnLifecycle: { turnId: 'turn-1', state: 'running' }
            }
          }
        ]
      }) as unknown as ReturnType<typeof ctx.journal.snapshot>
    expect(conversationCommandBlocked(ctx, RECORD)).toBe(
      'Wait for the current turn to finish before using this command.'
    )
  })
})

describe('conversationCommandBlocked unsettled submissions', () => {
  it('admits the command on a recovered unknown nothing can ever settle', () => {
    // Crash recovery skips rows it already marked, the restart reconciler only
    // narrows accepted outcomes, and Retry drops the outbox entry without
    // touching the journal. Refusing here asks for a step that does not exist.
    const ctx = contextHolding([submission('unknown', { recovered: true })])
    expect(conversationCommandBlocked(ctx, RECORD)).toBeNull()
  })

  it('admits the command on a legacy host that publishes the reason without the marker', () => {
    const ctx = contextHolding([submission('unknown', { reason: DISPATCH_DOUBT_HOST_RESTARTED })])
    expect(conversationCommandBlocked(ctx, RECORD)).toBeNull()
  })

  it('admits the command on a dead generation the current fence has passed', () => {
    const ctx = contextHolding([submission('pending', { fence: CURRENT_FENCE - 1 })])
    expect(conversationCommandBlocked(ctx, RECORD)).toBeNull()
  })

  it('still refuses while this generation owes an answer', () => {
    expect(conversationCommandBlocked(contextHolding([submission('pending')]), RECORD)).toBe(
      UNSETTLED_REFUSAL
    )
    expect(conversationCommandBlocked(contextHolding([submission('unknown')]), RECORD)).toBe(
      UNSETTLED_REFUSAL
    )
  })

  it('admits the command once every submission is terminally settled', () => {
    const ctx = contextHolding([
      submission('accepted', { clientMessageId: 'm1' }),
      submission('rejected', { clientMessageId: 'm2' })
    ])
    expect(conversationCommandBlocked(ctx, RECORD)).toBeNull()
  })
})
