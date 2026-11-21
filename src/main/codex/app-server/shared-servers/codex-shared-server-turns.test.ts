import { describe, expect, it } from 'vitest'
import { CodexSharedServerTurns } from './codex-shared-server-turns'

describe('shared Codex server turns', () => {
  it('gives every Stop retry on a turn that never ends the same waiter, settled once it ends', async () => {
    const turns = new CodexSharedServerTurns()
    turns.noteStarted('thread-1', 'turn-1')
    const first = turns.ended('turn-1')
    for (let retry = 0; retry < 288; retry += 1) {
      expect(turns.ended('turn-1')).toBe(first)
    }
    turns.observe('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } })
    await expect(first).resolves.toBeUndefined()
  })
})
