import { describe, expect, it } from 'vitest'
import {
  CodexJournalActiveTurns,
  CodexJournalRecentTurns,
  MAX_CODEX_RECENT_TURN_BYTES,
  MAX_CODEX_RECENT_TURNS
} from './codex-structured-journal-translation-turn-state'

describe('CodexJournalActiveTurns', () => {
  it('remembers each turn start time until the turn is forgotten', () => {
    const active = new CodexJournalActiveTurns()

    active.remember('thread', 'turn-1', 1_000)
    active.remember('thread', 'turn-1', 2_000)
    expect(active.startedAt('thread', 'turn-1')).toBe(1_000)
    expect(active.startedAt('thread', 'turn-missing')).toBeUndefined()

    active.forget('thread', 'turn-1')
    expect(active.startedAt('thread', 'turn-1')).toBeUndefined()
  })

  it('uses dispatch order even when the host clock moves backwards', () => {
    const active = new CodexJournalActiveTurns()
    active.remember('thread', 'turn-1', 1_000, 1)
    const laterSend = { requestedAt: 700, sequence: 1, userItemId: 'later-send' }
    const openingSend = { requestedAt: 1_100, sequence: 0, userItemId: 'opening-send' }

    expect(active.requestOriginRevision('thread', 'turn-1', laterSend)).toMatchObject({
      userItemId: 'later-send'
    })
    active.rememberRequestOrigin('thread', 'turn-1', laterSend)
    expect(active.requestOriginRevision('thread', 'turn-1', openingSend)).toMatchObject({
      requestedAt: 1_100,
      userItemId: 'opening-send'
    })
    active.rememberRequestOrigin('thread', 'turn-1', openingSend)
    expect(active.requestOriginRevision('thread', 'turn-1', laterSend)).toBeNull()
  })

  it('does not attribute a dispatch armed after the provider turn started', () => {
    const active = new CodexJournalActiveTurns()
    active.remember('thread', 'turn-1', 1_000, -1)

    expect(
      active.requestOriginRevision('thread', 'turn-1', {
        requestedAt: 900,
        sequence: 0,
        userItemId: 'mid-turn-send'
      })
    ).toBeNull()
  })
})

describe('CodexJournalRecentTurns', () => {
  it('evicts the oldest terminal turn at its bounded capacity', () => {
    const recent = new CodexJournalRecentTurns()
    for (let index = 0; index <= MAX_CODEX_RECENT_TURNS; index += 1) {
      recent.remember('thread', {
        turnId: `turn-${index}`,
        state: 'completed',
        userItemId: `user-${index}`,
        startedAt: 1_000,
        completedAt: 2_000
      })
    }

    expect(recent.size).toBe(MAX_CODEX_RECENT_TURNS)
    expect(recent.bytes).toBeLessThanOrEqual(MAX_CODEX_RECENT_TURN_BYTES)
    expect(
      recent.requestOriginRevision('thread', 'turn-0', {
        requestedAt: 900,
        sequence: 0,
        userItemId: 'opening-send'
      })
    ).toBeNull()

    recent.clear()
    expect(recent.size).toBe(0)
    expect(recent.bytes).toBe(0)
  })
})
