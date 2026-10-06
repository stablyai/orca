import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareClaudeTerminalAuth } from './claude-launch-auth'
import {
  hasClaudeCredentialOwners,
  hasLiveLegacyClaudePtys
} from '../../../claude-accounts/live-pty-gate'

vi.mock('../../../claude-accounts/claude-profile-cli', () => ({
  pinClaudeProfileTerminalCommand: async (command: string) => command
}))
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
})
const base = {
  isClaudeLaunch: true,
  reattach: false,
  command: 'claude',
  resumesConversation: false,
  target: { runtime: 'host' as const }
}

describe('Claude launch credential reservations', () => {
  it('holds ownership after preparation until the spawn commits or fails', async () => {
    const prepare = vi.fn(async () => ({
      configDir: '/account-a',
      envPatch: { CLAUDE_CONFIG_DIR: '/account-a' },
      stripAuthEnv: true,
      isolatedCredentials: true,
      accountId: 'a',
      provenance: 'managed:a'
    }))
    const result = await prepareClaudeTerminalAuth({
      ...base,
      launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: 'a' },
      prepare
    })
    releases.push(result.release!)
    expect(prepare).toHaveBeenCalledWith({ runtime: 'host' }, { accountId: 'a' })
    expect(hasClaudeCredentialOwners()).toBe(true)
    expect(hasLiveLegacyClaudePtys()).toBe(false)
    result.release?.()
    expect(hasClaudeCredentialOwners()).toBe(false)
  })
  it('releases failed preparations and protects pending legacy launches', async () => {
    await expect(
      prepareClaudeTerminalAuth({
        ...base,
        prepare: async () => {
          throw new Error('missing credential')
        }
      })
    ).rejects.toThrow('missing credential')
    expect(hasClaudeCredentialOwners()).toBe(false)
    const result = await prepareClaudeTerminalAuth(base)
    releases.push(result.release!)
    expect(hasLiveLegacyClaudePtys()).toBe(true)
  })
  it('refuses ambiguous legacy resume before resolving authentication', async () => {
    const prepare = vi.fn()
    await expect(
      prepareClaudeTerminalAuth({ ...base, resumesConversation: true, migrationAt: 1, prepare })
    ).rejects.toThrow('no verified account binding')
    expect(prepare).not.toHaveBeenCalled()
    expect(hasClaudeCredentialOwners()).toBe(false)
  })
})
