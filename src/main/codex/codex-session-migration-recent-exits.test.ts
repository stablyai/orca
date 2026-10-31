import { describe, expect, it } from 'vitest'
import { CodexSessionMigrationRecentExits } from './codex-session-migration-recent-exits'

describe('CodexSessionMigrationRecentExits', () => {
  it('refreshes a rerecorded ID before evicting the oldest entry', () => {
    const exits = new CodexSessionMigrationRecentExits()
    for (let index = 0; index < 256; index += 1) {
      exits.record(`pty-${index}`, index + 1)
    }

    exits.record('pty-0', 500)
    exits.record('pty-overflow', 501)

    expect(exits.matchesAfter('pty-0', 499)).toBe(true)
    expect(exits.matchesAfter('pty-1', 0)).toBe(false)
  })
})
