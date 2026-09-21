import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sameClaudeConfigDir } from './claude-config-dir-identity'
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

describe('config dir identity across filesystems', () => {
  it('treats a macOS case variant of the default home as the default', () => {
    const env = { CLAUDE_CONFIG_DIR: '/Users/work/.claude' }
    expect(claudeConfigDirEnvPatch('/Users/work/.Claude', { env, platform: 'darwin' })).toEqual({})
    expect(isCustomClaudeConfigDir('/Users/work/.Claude', { env, platform: 'darwin' })).toBe(false)
    expect(
      isCustomClaudeConfigDir(`${homedir().toUpperCase()}/.CLAUDE`, {
        env: {},
        platform: 'darwin'
      })
    ).toBe(false)
  })

  it('treats a symlink alias of the default home as the default', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-home-alias-'))
    const realHome = join(root, 'real')
    mkdirSync(join(realHome, '.claude'), { recursive: true })
    const aliasHome = join(root, 'alias')
    symlinkSync(realHome, aliasHome, 'dir')
    try {
      const env = { CLAUDE_CONFIG_DIR: join(realHome, '.claude') }
      const alias = join(aliasHome, '.claude')
      expect(isCustomClaudeConfigDir(alias, { env, platform: 'darwin' })).toBe(false)
      expect(claudeConfigDirEnvPatch(alias, { env, platform: 'darwin' })).toEqual({})
      expect(isCustomClaudeConfigDir(alias, { env, platform: 'linux' })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps Linux case-sensitive, where a case variant is a different directory', () => {
    const env = { CLAUDE_CONFIG_DIR: '/home/work/.claude' }
    expect(isCustomClaudeConfigDir('/home/work/.Claude', { env, platform: 'linux' })).toBe(true)
    expect(claudeConfigDirEnvPatch('/home/work/.Claude', { env, platform: 'linux' })).toEqual({
      CLAUDE_CONFIG_DIR: '/home/work/.Claude'
    })
  })

  it('classifies the root-ish bindings U1 accepts without crashing', () => {
    const env = { CLAUDE_CONFIG_DIR: '/Users/work/.claude' }
    for (const binding of ['//', '///x', '//server']) {
      expect(isCustomClaudeConfigDir(binding, { env, platform: 'darwin' })).toBe(true)
    }
  })
})

describe('the pin and the refusal checks share one path-identity answer', () => {
  // A disagreement between the two is the defect: they answer the same question — is this the
  // CLI's own default home — on different code paths.
  it('agrees with sameClaudeConfigDir on every input', () => {
    const defaultHome = '/Users/work/.claude'
    const env = { CLAUDE_CONFIG_DIR: defaultHome }
    const bindings = [
      defaultHome,
      `${defaultHome}/`,
      '/Users/work/.Claude',
      '/users/WORK/.claude',
      '/Users//work/./.claude',
      '/Users/work/.claude-other',
      '/accounts/claude/managed',
      '//',
      '///x',
      '//server'
    ]
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const binding of bindings) {
        expect(isCustomClaudeConfigDir(binding, { env, platform })).toBe(
          !sameClaudeConfigDir(binding, defaultHome, platform)
        )
      }
    }
  })
})
