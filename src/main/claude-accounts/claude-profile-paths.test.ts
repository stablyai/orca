import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
import {
  assertOutsideDefaultClaudeHomes,
  describeClaudeProfile,
  prepareClaudeProfileDirectory,
  readClaudeProfileObject
} from './claude-profile-paths'

// Case-only aliases exist only on a case-insensitive filesystem (default APFS, NTFS).
const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-case-probe-'))
  try {
    mkdirSync(join(dir, 'probe'))
    return existsSync(join(dir, 'PROBE'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-profile-paths-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
const local = { runtime: 'host', executionHostId: 'local' } as const

describe('Claude profile namespace', () => {
  it('binds the new namespace to an account and execution target without touching legacy auth', () => {
    const dir = root()
    const userHome = root()
    const target = { executionHostId: 'runtime:env-1', runtime: 'wsl', distro: 'Ubuntu' } as const
    const profile = describeClaudeProfile(dir, 'account-a', target)
    expect(profile).toEqual({
      version: 1,
      accountId: 'account-a',
      target,
      home: join(dir, 'claude-profiles/account-a/home')
    })
    prepareClaudeProfileDirectory(dir, profile, userHome)
    expect(
      JSON.parse(readFileSync(join(dir, 'claude-profiles/account-a/profile.json'), 'utf8'))
    ).toEqual({ version: 1, accountId: 'account-a', runtime: 'wsl', distro: 'Ubuntu' })
    // The host id is the caller's view of the host, so another caller's spelling is the same profile.
    prepareClaudeProfileDirectory(
      dir,
      { ...profile, target: { distro: 'Ubuntu', runtime: 'wsl', executionHostId: 'local' } },
      userHome
    )
    expect(() =>
      prepareClaudeProfileDirectory(
        dir,
        { ...profile, home: join(dir, 'claude-accounts/account-a/auth') },
        userHome
      )
    ).toThrow()
    expect(() => describeClaudeProfile(dir, '../escape', target)).toThrow()
    expect(() => describeClaudeProfile('C:\\orca', 'a', target)).toThrow()
  })
  it('refuses a profile whose marker names another account or target, creating nothing', () => {
    const dir = root()
    const userHome = root()
    mkdirSync(join(dir, 'claude-profiles/a'), { recursive: true })
    const marker = join(dir, 'claude-profiles/a/profile.json')
    for (const other of [
      { version: 1, accountId: 'b', runtime: 'host' },
      { version: 1, accountId: 'a', runtime: 'wsl', distro: 'Ubuntu' }
    ]) {
      writeFileSync(marker, JSON.stringify(other))
      expect(() =>
        prepareClaudeProfileDirectory(dir, describeClaudeProfile(dir, 'a', local), userHome)
      ).toThrow('another account')
    }
    writeFileSync(marker, '{')
    expect(() =>
      prepareClaudeProfileDirectory(dir, describeClaudeProfile(dir, 'a', local), userHome)
    ).toThrow('unreadable')
    expect(existsSync(join(dir, 'claude-profiles/a/home'))).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('{')
  })
  it('rejects a linked account parent before creating a profile outside the namespace', () => {
    const dir = root()
    mkdirSync(join(dir, 'claude-profiles'))
    const outside = root()
    symlinkSync(outside, join(dir, 'claude-profiles/a'), 'junction')
    expect(() =>
      prepareClaudeProfileDirectory(dir, describeClaudeProfile(dir, 'a', local), root())
    ).toThrow('link')
  })
  it('refuses a data root inside the default Claude home', () => {
    const userHome = root()
    const dataRoot = join(userHome, '.claude', 'orca')
    expect(() =>
      prepareClaudeProfileDirectory(dataRoot, describeClaudeProfile(dataRoot, 'a', local), userHome)
    ).toThrow('separate directories')
    expect(existsSync(join(userHome, '.claude'))).toBe(false)
  })
  it.runIf(caseInsensitive)('refuses a case-only alias of the default home', () => {
    const userHome = root()
    mkdirSync(join(userHome, '.claude'))
    expect(() => assertOutsideDefaultClaudeHomes(join(userHome, '.CLAUDE'), userHome)).toThrow(
      'separate directories'
    )
    expect(() =>
      assertOutsideDefaultClaudeHomes(join(userHome, '.CLAUDE', 'nested'), userHome)
    ).toThrow('separate directories')
  })
  it('distinguishes missing from empty, malformed, nonobject and inaccessible JSON', () => {
    const file = join(root(), 'state.json')
    expect(readClaudeProfileObject(file).kind).toBe('absent')
    for (const value of ['', '{', '[]', 'null']) {
      writeFileSync(file, value)
      expect(readClaudeProfileObject(file).kind).toBe('unavailable')
    }
    // ENOTDIR is a definitive absence, as everywhere else in Orca.
    expect(readClaudeProfileObject(join(file, 'child')).kind).toBe('absent')
    mkdirSync(join(file, '..', 'dir.json'))
    expect(readClaudeProfileObject(join(file, '..', 'dir.json')).kind).toBe('unavailable')
    writeFileSync(file, '{"theme":"dark"}')
    expect(readClaudeProfileObject(file)).toEqual({ kind: 'present', value: { theme: 'dark' } })
  })
})
