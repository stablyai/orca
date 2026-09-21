import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeConfigDirEnvPatch,
  defaultClaudeConfigDir,
  isCustomClaudeConfigDir
} from './claude-config-dir-pin'

describe('claude config dir pin', () => {
  it('does not pin the CLI default home, so the macOS Keychain stays reachable', () => {
    expect(claudeConfigDirEnvPatch(join(homedir(), '.claude'), { env: {} })).toEqual({})
    expect(claudeConfigDirEnvPatch(`${join(homedir(), '.claude')}/`, { env: {} })).toEqual({})
    expect(claudeConfigDirEnvPatch('  ', { env: {} })).toEqual({})
  })

  it('pins a managed account home the CLI would not find on its own', () => {
    expect(claudeConfigDirEnvPatch('/accounts/claude/managed', { env: {} })).toEqual({
      CLAUDE_CONFIG_DIR: '/accounts/claude/managed'
    })
  })

  it('treats an inherited CLAUDE_CONFIG_DIR as the default the CLI already resolves', () => {
    const env = { CLAUDE_CONFIG_DIR: '/inherited/home' }
    expect(defaultClaudeConfigDir(env)).toBe('/inherited/home')
    expect(claudeConfigDirEnvPatch('/inherited/home', { env })).toEqual({})
    expect(claudeConfigDirEnvPatch('/other/home', { env })).toEqual({
      CLAUDE_CONFIG_DIR: '/other/home'
    })
  })

  it('compares Windows homes case-insensitively', () => {
    const env = { CLAUDE_CONFIG_DIR: 'C:\\Users\\Work\\.claude' }
    expect(claudeConfigDirEnvPatch('c:\\users\\work\\.claude', { env, platform: 'win32' })).toEqual(
      {}
    )
  })
})

describe('isCustomClaudeConfigDir', () => {
  // The one predicate the pin and all three gate readers share, so a no-op binding cannot read as
  // a custom home in one place and as the shared home in another.
  it('answers exactly when the pin would emit something', () => {
    const env = { CLAUDE_CONFIG_DIR: '/inherited/home' }
    expect(isCustomClaudeConfigDir('/inherited/home', { env })).toBe(false)
    expect(isCustomClaudeConfigDir('/other/home', { env })).toBe(true)
    expect(isCustomClaudeConfigDir(defaultClaudeConfigDir({}), { env: {} })).toBe(false)
    expect(isCustomClaudeConfigDir('   ', { env: {} })).toBe(false)
  })
})
