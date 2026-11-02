// Why: locks the hook settings target to the config dir the Claude CLI actually reads,
// so a set CLAUDE_CONFIG_DIR cannot strand Orca's managed hooks in an unread ~/.claude (#24873).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_HOOK_SETTINGS, getConfigPath, OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('getConfigPath', () => {
  it('follows a set CLAUDE_CONFIG_DIR, the same resolution as the rest of Orca\u2019s Claude code', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join('/config', 'claude-alt'))
    expect(getConfigPath()).toBe(join('/config', 'claude-alt', 'settings.json'))
  })

  it('keeps the legacy ~/.claude path when the variable is unset, so the fallback is unchanged', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(getConfigPath()).toBe(join(homedir(), '.claude', 'settings.json'))
  })

  it('falls back on a whitespace-only value and keeps a real value verbatim, like defaultClaudeConfigDir', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '   ')
    expect(getConfigPath()).toBe(join(homedir(), '.claude', 'settings.json'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', `${join('/config', 'claude-alt')}/`)
    expect(getConfigPath()).toBe(join('/config', 'claude-alt', 'settings.json'))
  })

  it('leaves Claude-compatible CLIs on their own home directory', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join('/config', 'claude-alt'))
    expect(getConfigPath(OPENCLAUDE_HOOK_SETTINGS)).toBe(
      join(homedir(), '.openclaude', 'settings.json')
    )
    expect(getConfigPath(CLAUDE_HOOK_SETTINGS)).toBe(join('/config', 'claude-alt', 'settings.json'))
  })
})
