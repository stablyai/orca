import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

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

const RECORD = { lease: {} } as unknown as AgentSessionRecord

describe('conversationCommandBlocked background tasks', () => {
  it('admits the command when nothing is being monitored', () => {
    expect(conversationCommandBlocked(contextWith(null), RECORD)).toBeNull()
  })

  it('asks for a stop when the host accepts targeted stops', () => {
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsTaskStop: true }),
      RECORD
    )
    expect(blocked?.message).toBe('Stop background tasks before using this command.')
  })

  it('asks for a stop on a host that predates the stop-capability field', () => {
    const blocked = conversationCommandBlocked(contextWith({ state: 'monitoring' }), RECORD)
    expect(blocked?.message).toBe('Stop background tasks before using this command.')
  })

  it('asks the user to wait when the provider exposes no stop at all', () => {
    // Codex: an instruction to stop would name a control that does not exist.
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsStopAll: false }),
      RECORD
    )
    expect(blocked?.message).toBe('Wait for background tasks to finish before using this command.')
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
    expect(conversationCommandBlocked(ctx, RECORD)?.message).toBe(
      'Wait for the current turn to finish before using this command.'
    )
  })
})

describe('conversationCommandBlocked for a command sent at rest (C6, B3)', () => {
  const staleTurn = {
    items: [{ itemId: 'turn-1', body: { kind: 'turn', turnId: 'turn-1', state: 'running' } }]
  }

  it("does not refuse over a dead generation's running turn, which the start sweeps", () => {
    const ctx = contextWith(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only each item's body.
    ctx.journal.snapshot = () => staleTurn as never
    expect(conversationCommandBlocked(ctx, RECORD, 'at-rest')).toBeNull()
    expect(conversationCommandBlocked(ctx, RECORD)).toMatchObject({
      details: { reason: 'turnActive' },
      message: 'Wait for the current turn to finish before using this command.'
    })
  })

  it("ignores an older build's compaction record", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the lease and the command record.
    const record = {
      lease: {},
      conversationCommand: { command: 'compact', phase: 'prepared', state: 'unknown' }
    } as unknown as AgentSessionRecord
    expect(conversationCommandBlocked(contextWith(null), record)).toBeNull()
  })

  // A clear's commit is its only durable write, so a record short of it never changed the chat.
  it("ignores a clear that never committed, as an older build's record leaves one", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the lease and the command record.
    const record = {
      lease: {},
      conversationCommand: {
        command: 'clear',
        phase: 'prepared',
        state: 'unknown',
        replacementSessionId: 'clear-replacement'
      }
    } as unknown as AgentSessionRecord
    expect(conversationCommandBlocked(contextWith(null), record)).toBeNull()
  })

  it('refuses on a committed clear', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the lease and the command record.
    const record = {
      lease: {},
      conversationCommand: {
        command: 'clear',
        phase: 'committed',
        state: 'completed',
        replacementSessionId: 'clear-replacement'
      }
    } as unknown as AgentSessionRecord
    expect(conversationCommandBlocked(contextWith(null), record)).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationCleared' }
    })
  })

  it('at handover, lets the command itself and messages queued behind it wait', () => {
    const ctx = contextWith(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the dispatch fields.
    const queued = [
      { clientMessageId: 'command', dispatchState: 'pending', handoverRecorded: true },
      { clientMessageId: 'behind', dispatchState: 'pending', handoverRecorded: true }
    ] as never
    ctx.journal.submissions = () => queued
    expect(conversationCommandBlocked(ctx, RECORD, 'handover')).toBeNull()
  })
})
