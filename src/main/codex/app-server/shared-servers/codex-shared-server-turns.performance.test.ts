import { describe, expect, it } from 'vitest'
import { CodexSharedServerTurns } from './codex-shared-server-turns'

describe('shared Codex server turn waits', () => {
  it('keeps nothing from Stop retries that timed out on a turn that never ended', async () => {
    const turns = new CodexSharedServerTurns()
    turns.noteStarted('thread-1', 'turn-1')
    let checks = 0
    const ended = (): boolean => {
      checks += 1
      return turns.runningOn('thread-1') !== 'turn-1'
    }
    // A day of retries at the slowest pace, each giving up at its deadline (1 ms here).
    for (let retry = 0; retry < 288; retry += 1) {
      await expect(turns.waitUntil(ended, 1)).resolves.toBe(false)
    }
    const live = turns.waitUntil(ended, 60_000)
    checks = 0
    turns.observe('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } })
    await expect(live).resolves.toBe(true)
    // Only the one live wait re-checked; the 288 expired ones are gone.
    expect(checks).toBe(1)
  })
})
