import { describe, expect, it } from 'vitest'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'

describe('CodexJournalActiveTurns', () => {
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
