import { describe, expect, it } from 'vitest'
import { retainNewestRestorableTerminalHistorySessions } from './terminal-history-restorable-retention'

describe('retainNewestRestorableTerminalHistorySessions', () => {
  it('preserves enumeration order exactly at the cap', () => {
    const sessions = [
      { sessionId: 'middle', startedAtMs: 2, order: 0 },
      { sessionId: 'oldest', startedAtMs: 1, order: 1 },
      { sessionId: 'newest', startedAtMs: 3, order: 2 }
    ]

    expect(retainNewestRestorableTerminalHistorySessions(sessions, sessions.length)).toEqual([
      'middle',
      'oldest',
      'newest'
    ])
  })

  it('retains the newest sessions while preserving their relative enumeration order', () => {
    const sessions = [
      { sessionId: 'middle', startedAtMs: 2, order: 0 },
      { sessionId: 'oldest', startedAtMs: 1, order: 1 },
      { sessionId: 'newest', startedAtMs: 4, order: 2 },
      { sessionId: 'newer', startedAtMs: 3, order: 3 }
    ]

    expect(retainNewestRestorableTerminalHistorySessions(sessions, 2)).toEqual(['newest', 'newer'])
  })
})
