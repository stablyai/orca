import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyClaudeFolderTrust,
  grantClaudeFolderTrust,
  grantClaudeWorkspaceTrust,
  resolveClaudeGlobalConfigFile,
  resolveLocalClaudeTrustConfig,
  toClaudeTrustKey
} from './claude-folder-trust-file'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(file: string, value: unknown, mode = 0o600): void {
  writeFileSync(file, JSON.stringify(value), { mode })
  chmodSync(file, mode)
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

describe('toClaudeTrustKey', () => {
  it('NFC-normalises so a decomposed path matches the key Claude looks up', () => {
    const decomposed = '/tmp/cafe\u0301'
    expect(toClaudeTrustKey(decomposed, 'posix')).toBe('/tmp/caf\u00e9')
  })

  it('uses forward slashes on Windows, as Claude does', () => {
    expect(toClaudeTrustKey('C:\\Users\\me\\wt\\', 'win32')).toBe('C:/Users/me/wt/')
    expect(toClaudeTrustKey('C:\\Users\\me\\.\\wt', 'win32')).toBe('C:/Users/me/wt')
  })
})

describe('resolveClaudeGlobalConfigFile', () => {
  const none = (): boolean => false

  it('defaults to ~/.claude.json, never ~/.claude/.claude.json', () => {
    expect(
      resolveClaudeGlobalConfigFile({ env: {}, homeDir: '/home/u', style: 'posix', exists: none })
    ).toBe('/home/u/.claude.json')
  })

  it('uses CLAUDE_CONFIG_DIR/.claude.json when set', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: { CLAUDE_CONFIG_DIR: '/cfg' },
        homeDir: '/home/u',
        style: 'posix',
        exists: none
      })
    ).toBe('/cfg/.claude.json')
  })

  it('prefers the legacy .config.json in the config dir', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: {},
        homeDir: '/home/u',
        style: 'posix',
        exists: (p) => p === '/home/u/.claude/.config.json'
      })
    ).toBe('/home/u/.claude/.config.json')
  })

  it('follows the custom-OAuth file suffix', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://x' },
        homeDir: '/home/u',
        style: 'posix',
        exists: none
      })
    ).toBe('/home/u/.claude-custom-oauth.json')
  })
})

describe('applyClaudeFolderTrust', () => {
  it('is a no-op when the folder is already trusted', () => {
    expect(
      applyClaudeFolderTrust({ projects: { '/wt': { hasTrustDialogAccepted: true } } }, ['/wt'])
    ).toEqual({ kind: 'unchanged' })
  })

  it('refuses a non-object projects map instead of replacing it', () => {
    expect(applyClaudeFolderTrust({ projects: [] }, ['/wt'])).toEqual({ kind: 'refuse' })
  })

  it("keeps Claude's own fields on an existing untrusted entry", () => {
    expect(
      applyClaudeFolderTrust({ projects: { '/wt': { allowedTools: ['x'] } } }, ['/wt'])
    ).toEqual({
      kind: 'changed',
      config: { projects: { '/wt': { allowedTools: ['x'], hasTrustDialogAccepted: true } } }
    })
  })
})

describe('grantClaudeFolderTrust', () => {
  it('merges the key and keeps every other field', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] } }
    })
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'granted'
    )
    expect(readConfig(file)).toEqual({
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] },
        '/wt': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('keeps an owner-only mode through the rewrite', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {}, 0o600)
    await grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('never creates a missing config file', async () => {
    const file = join(root, '.claude.json')
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'missing-config'
    )
    expect(existsSync(file)).toBe(false)
  })

  it('leaves a corrupt file byte-for-byte untouched', async () => {
    const file = join(root, '.claude.json')
    writeFileSync(file, '{"oauthAccount": ', { mode: 0o600 })
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'unreadable'
    )
    expect(readFileSync(file, 'utf-8')).toBe('{"oauthAccount": ')
  })

  it('does nothing while Claude holds its lock, and leaves the lock in place', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    const lockDir = `${file}.lock`
    mkdirSync(lockDir)
    const oldTime = new Date(Date.now() - 60_000)
    // Why: a lock older than Claude's 10 s stale window must still not be broken by Orca.
    utimesSync(lockDir, oldTime, oldTime)
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'locked'
    )
    expect(readConfig(file)).toEqual({})
    expect(existsSync(lockDir)).toBe(true)
  })

  it('updates a symlinked config through its target and keeps the link', async () => {
    const target = join(root, 'dotfiles-claude.json')
    const link = join(root, '.claude.json')
    writeConfig(target, { theme: 'dark' })
    symlinkSync(target, link)
    await grantClaudeFolderTrust({ configFile: link, folderKeys: ['/wt'] })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readConfig(target)).toEqual({
      theme: 'dark',
      projects: { '/wt': { hasTrustDialogAccepted: true } }
    })
  })

  it('leaves the parent directory mode alone', async () => {
    const home = join(root, 'home')
    mkdirSync(home, { mode: 0o755 })
    chmodSync(home, 0o755)
    const file = join(home, '.claude.json')
    writeConfig(file, {})
    await grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })
    expect(statSync(home).mode & 0o777).toBe(0o755)
  })

  it('grants every folder of a launch burst instead of losing some to its own lock', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    const keys = Array.from({ length: 12 }, (_, index) => `/wt-${index}`)
    const outcomes = await Promise.all(
      keys.map((key) => grantClaudeFolderTrust({ configFile: file, folderKeys: [key] }))
    )
    expect(outcomes).toEqual(keys.map(() => 'granted'))
    expect(readConfig(file).projects).toEqual(
      Object.fromEntries(keys.map((key) => [key, { hasTrustDialogAccepted: true }]))
    )
  })
})

describe('grantClaudeWorkspaceTrust', () => {
  it('writes the given folder and its realpath form, whatever kind of folder it is', async () => {
    const real = join(root, 'real-folder')
    mkdirSync(real)
    const link = join(root, 'linked-folder')
    symlinkSync(real, link)
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    await expect(
      grantClaudeWorkspaceTrust({ configFile: file, keyStyle: 'posix' }, link)
    ).resolves.toBe('granted')
    expect(readConfig(file)).toEqual({
      projects: {
        [link]: { hasTrustDialogAccepted: true },
        [real]: { hasTrustDialogAccepted: true }
      }
    })
  })

  it('does not take the lock when the folder is already trusted', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, { projects: { [root]: { hasTrustDialogAccepted: true } } })
    mkdirSync(`${file}.lock`)
    await expect(
      grantClaudeWorkspaceTrust({ configFile: file, keyStyle: 'posix' }, root)
    ).resolves.toBe('unchanged')
  })

  it('maps a host path to the path Claude sees and skips one it cannot map', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    await grantClaudeWorkspaceTrust(
      { configFile: file, keyStyle: 'posix', toClaudePath: () => '/home/u/wt' },
      join(root, 'missing')
    )
    expect(readConfig(file)).toEqual({
      projects: { '/home/u/wt': { hasTrustDialogAccepted: true } }
    })
    await expect(
      grantClaudeWorkspaceTrust(
        { configFile: file, keyStyle: 'posix', toClaudePath: () => null },
        join(root, 'other')
      )
    ).resolves.toBe('unchanged')
  })
})

describe('resolveLocalClaudeTrustConfig', () => {
  const wslAuth: ClaudeRuntimeAuthPreparation = {
    configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude',
    runtime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxConfigDir: '/home/u/.claude',
    envPatch: {},
    stripAuthEnv: true,
    provenance: 'wsl:Ubuntu:system'
  }

  it('reads the final spawn env for a host launch', () => {
    const target = resolveLocalClaudeTrustConfig({
      workspacePath: '/repo/wt',
      env: { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/u' },
      claudeAuth: null,
      wslDistro: null
    })
    expect(target?.configFile).toBe(join('/cfg', '.claude.json'))
  })

  it("never writes the Windows host's file for a WSL launch it cannot map to the guest", () => {
    for (const args of [
      { claudeAuth: null, wslDistro: 'Ubuntu' },
      { claudeAuth: { ...wslAuth, wslLinuxConfigDir: null }, wslDistro: 'Ubuntu' },
      { claudeAuth: wslAuth, wslDistro: 'Ubuntu', workspacePath: 'C:\\repo\\wt' }
    ]) {
      expect(
        resolveLocalClaudeTrustConfig({
          workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt',
          env: { HOME: '/home/win' },
          ...args
        })
      ).toBeNull()
    }
  })

  it("targets the guest's own file and Linux keys for a WSL launch", () => {
    const target = resolveLocalClaudeTrustConfig({
      workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt',
      env: {},
      claudeAuth: wslAuth,
      wslDistro: 'Ubuntu'
    })
    expect(target?.keyStyle).toBe('posix')
    expect(target?.toClaudePath?.('\\\\wsl.localhost\\Ubuntu\\home\\u\\wt')).toBe('/home/u/wt')
  })
})
