import { describe, expect, it } from 'vitest'
import { withHostAccountLaunchEnv } from './runtime-agent-terminal-startup'

describe('withHostAccountLaunchEnv', () => {
  it("carries the caller's own account to spawn, also where this host pushes none", () => {
    const requested = {
      env: { CLAUDE_CONFIG_DIR: '/caller/claude', EDITOR: 'vim' },
      accountEnv: { CODEX_HOME: '/caller/codex' }
    }
    const launch = { command: 'claude', env: { CLAUDE_CONFIG_DIR: '/caller/claude' } }
    expect(withHostAccountLaunchEnv(requested, launch, {}).accountEnv).toEqual({
      CLAUDE_CONFIG_DIR: '/caller/claude',
      CODEX_HOME: '/caller/codex'
    })
    expect(
      withHostAccountLaunchEnv(requested, launch, { CLAUDE_CONFIG_DIR: '/pushed/claude' })
    ).toMatchObject({
      env: { CLAUDE_CONFIG_DIR: '/caller/claude', CODEX_HOME: '/caller/codex' },
      accountEnv: { CLAUDE_CONFIG_DIR: '/caller/claude', CODEX_HOME: '/caller/codex' }
    })
    expect(withHostAccountLaunchEnv({}, launch, {}).accountEnv).toBeUndefined()
  })
})
