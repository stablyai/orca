import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) }
})
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'

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
  vi.mocked(unlinkSync).mockReset()
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
const local = { runtime: 'host', executionHostId: 'local' } as const

describe('Claude profile namespace', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts a WSL casing alias while retaining the original marker and rejecting other owners',
    () => {
      const dir = root()
      const userHome = root()
      const profile = describeClaudeProfile(dir, 'a', {
        ...local,
        runtime: 'wsl',
        distro: 'Ubuntu'
      })
      prepareClaudeProfileDirectory(dir, profile, userHome)()
      const marker = join(dir, 'claude-profiles/a/profile.json')
      const original = readFileSync(marker, 'utf8')
      prepareClaudeProfileDirectory(
        dir,
        { ...profile, target: { ...profile.target, runtime: 'wsl', distro: 'ubuntu' } },
        userHome
      )()
      expect(readFileSync(marker, 'utf8')).toBe(original)
      for (const distro of ['Debian', 'Ubuntu-24.04']) {
        expect(() =>
          prepareClaudeProfileDirectory(
            dir,
            { ...profile, target: { ...local, runtime: 'wsl', distro } },
            userHome
          )
        ).toThrow('another account or target')
      }
      writeFileSync(
        marker,
        JSON.stringify({ version: 1, accountId: 'b', runtime: 'wsl', distro: 'ubuntu' })
      )
      expect(() => prepareClaudeProfileDirectory(dir, profile, userHome)).toThrow(
        'another account or target'
      )
    }
  )

  // A WSL profile's data root is a POSIX path; a Windows temp dir cannot be one.

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
      expect(readFileSync(marker, 'utf8')).toBe(JSON.stringify(other))
      expect(existsSync(join(dir, 'claude-profiles/a/home'))).toBe(false)
    }
    writeFileSync(marker, '{')
    expect(() =>
      prepareClaudeProfileDirectory(dir, describeClaudeProfile(dir, 'a', local), userHome)
    ).toThrow('unreadable')
    expect(existsSync(join(dir, 'claude-profiles/a/home'))).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('{')
  })
  it('does not recreate a home if its completion marker cannot be invalidated', () => {
    const dir = root()
    const userHome = root()
    const profile = describeClaudeProfile(dir, 'a', local)
    prepareClaudeProfileDirectory(dir, profile, userHome)()
    const marker = join(dir, 'claude-profiles/a/profile.json')
    const original = readFileSync(marker, 'utf8')
    rmSync(profile.home, { recursive: true })
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    expect(() => prepareClaudeProfileDirectory(dir, profile, userHome)).toThrow()
    expect(existsSync(profile.home)).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe(original)
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
    const dataRoot = join(userHome, '.CLAUDE', 'orca')
    expect(() =>
      prepareClaudeProfileDirectory(dataRoot, describeClaudeProfile(dataRoot, 'a', local), userHome)
    ).toThrow('separate directories')
  })
})
