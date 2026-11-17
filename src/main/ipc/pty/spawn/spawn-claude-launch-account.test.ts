import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE } from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import { prepareSpawnClaudeAccount } from './spawn-claude-launch-account'

const launch = {
  env: {
    KEEP: '1',
    CLAUDE_CONFIG_DIR: '/accounts/a',
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/accounts/a'
  },
  target: { runtime: 'host' as const },
  isClaudeLaunch: true,
  remote: false,
  pluginAccountId: 'b'
}

function prepareClaudeAuth() {
  return vi.fn(async () => ({ configDir: '/accounts/b', envPatch: {}, provenance: 'profile:b' }))
}

describe('a launch plugin choosing a Claude account', () => {
  it("prepares the chosen account and keeps the selection's folder out of the pane", async () => {
    const prepare = prepareClaudeAuth()
    const account = await prepareSpawnClaudeAccount({ ...launch, prepareClaudeAuth: prepare })
    expect(prepare).toHaveBeenCalledWith({ runtime: 'host' }, 'b')
    expect(account.env).toEqual({ KEEP: '1' })
  })

  it('refuses an SSH terminal, whose host prepares its own accounts', async () => {
    const prepare = prepareClaudeAuth()
    await expect(
      prepareSpawnClaudeAccount({ ...launch, remote: true, prepareClaudeAuth: prepare })
    ).rejects.toThrow(CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('refuses a command Orca does not run as Claude', async () => {
    const prepare = prepareClaudeAuth()
    await expect(
      prepareSpawnClaudeAccount({ ...launch, isClaudeLaunch: false, prepareClaudeAuth: prepare })
    ).rejects.toThrow(CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE)
    expect(prepare).not.toHaveBeenCalled()
  })
})
