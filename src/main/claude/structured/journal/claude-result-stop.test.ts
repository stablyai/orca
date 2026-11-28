import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  errorRows,
  openStopJournal
} from '../../../native-chat/agent-session-journal/journal-stop-writer.test-fixture'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

// Claude's error result after a person's Stop, through the real translator into the real journal
// writer: the Stop decides it only within its window, as it does Codex's failed end.
const NOW = 1_800_000_000_000
// The Stop's window, written out: the production constant doesn't exist before the fix.
const WINDOW_MS = 30_000
const SESSION = 'claude-session-1'
let journal: ReturnType<typeof openStopJournal>
beforeEach(() => {
  vi.useFakeTimers()
  journal = openStopJournal()
})
afterEach(() => {
  journal.close()
  vi.useRealTimers()
})

/** A running Claude turn, and its id as the journal names it. */
function claudeTurn() {
  vi.setSystemTime(NOW - 60_000)
  const translator = createClaudeJournalTranslator({ sink: journal.sink })
  const send = (message: Record<string, unknown>, observedAt: number, startsTurn?: true) => {
    vi.setSystemTime(observedAt)
    translator.handle({
      type: 'message',
      sessionId: 'chat-1',
      observedAt,
      message: { session_id: SESSION, parent_tool_use_id: null, ...message },
      ...(startsTurn ? { startsTurn } : {})
    })
  }
  send(
    {
      type: 'user',
      uuid: 'prompt-1',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the build' }] }
    },
    NOW - 60_000,
    true
  )
  const turnId = turnOf()?.turnId
  if (!turnId) {
    throw new Error('the prompt opened no turn')
  }
  return { send, turnId }
}

const turnOf = () =>
  journal
    .items()
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)

// An error Claude reports for the turn; not an abort, so the Stop rule decides how it reads.
const errorResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  num_turns: 1,
  result: 'API Error: 500 Internal server error'
}

describe('a Claude error result after a person stopped the turn', () => {
  it('reads as stopped, with no error row, within the window', () => {
    const { send, turnId } = claudeTurn()
    journal.stop('user-stop', NOW, turnId)
    send(errorResult, NOW + 2_000)
    expect(turnOf()).toMatchObject({ outcome: 'cancellation' })
    expect(errorRows(journal.items())).toEqual([])
  })

  it('reads as stopped at the window’s edge', () => {
    const { send, turnId } = claudeTurn()
    journal.stop('user-stop', NOW, turnId)
    send(errorResult, NOW + WINDOW_MS)
    expect(turnOf()).toMatchObject({ outcome: 'cancellation' })
  })

  it('keeps its failure and error row past the window', () => {
    const { send, turnId } = claudeTurn()
    journal.stop('user-stop', NOW, turnId)
    send(errorResult, NOW + WINDOW_MS + 1_000)
    expect(turnOf()).toMatchObject({ outcome: 'failure' })
    expect(errorRows(journal.items()).length).toBeGreaterThan(0)
  })

  it('keeps its failure and error row with no Stop', () => {
    const { send } = claudeTurn()
    send(errorResult, NOW)
    expect(turnOf()).toMatchObject({ outcome: 'failure' })
    expect(errorRows(journal.items()).length).toBeGreaterThan(0)
  })
})
