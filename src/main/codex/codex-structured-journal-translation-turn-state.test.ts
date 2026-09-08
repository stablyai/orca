import { describe, expect, it } from 'vitest'
import {
  CodexJournalActiveTurns,
  MAX_CODEX_ACTIVE_TURN_BYTES,
  MAX_CODEX_ACTIVE_TURNS
} from './codex-structured-journal-translation-turn-state'

describe('CodexJournalActiveTurns', () => {
  it('refuses new turns at the bounded active capacity without evicting live state', () => {
    const active = new CodexJournalActiveTurns()
    for (let index = 0; index < MAX_CODEX_ACTIVE_TURNS; index += 1) {
      expect(active.remember(`thread-${index}`, `turn-${index}`)).toBe(true)
    }

    expect(active.remember('thread-overflow', 'turn-overflow')).toBe(false)
    expect(active.size).toBe(MAX_CODEX_ACTIVE_TURNS)
    expect(active.byThread.size).toBe(MAX_CODEX_ACTIVE_TURNS)
    expect(active.current('thread-0')).toBe('turn-0')
    expect(active.current(`thread-${MAX_CODEX_ACTIVE_TURNS - 1}`)).toBe(
      `turn-${MAX_CODEX_ACTIVE_TURNS - 1}`
    )
  })

  it('admits a new turn after an earlier turn settles', () => {
    const active = new CodexJournalActiveTurns()
    for (let index = 0; index < MAX_CODEX_ACTIVE_TURNS; index += 1) {
      active.remember('thread', `turn-${index}`)
    }
    active.forget('thread', 'turn-0')

    expect(active.remember('thread', 'turn-new')).toBe(true)
    expect(active.size).toBe(MAX_CODEX_ACTIVE_TURNS)
    expect(active.current('thread')).toBe('turn-new')
  })

  it('refuses provider identifiers that would exceed the aggregate byte bound', () => {
    const active = new CodexJournalActiveTurns()

    expect(active.remember('thread', 'x'.repeat(MAX_CODEX_ACTIVE_TURN_BYTES))).toBe(false)
    expect(active.size).toBe(0)
    expect(active.bytes).toBe(0)
  })
})
