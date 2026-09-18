import { describe, expect, it } from 'vitest'

describe('Claude config isolation', () => {
  it('never lets a test see the host session CLAUDE_CONFIG_DIR', () => {
    // Launched from a Claude Code session, the variable names the developer's real
    // account, and the runtime-auth tests would delete and rewrite its credentials —
    // logging out every session on that account.
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
