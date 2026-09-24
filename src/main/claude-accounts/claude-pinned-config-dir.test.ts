import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({ symlinkTypes: [] as (string | null | undefined)[] }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    symlinkSync: (target: string, path: string, type?: 'dir' | 'file' | 'junction' | null) => {
      fsMock.symlinkTypes.push(type)
      // Why: junctions only exist on Windows; the call shape is what this suite asserts.
      actual.symlinkSync(target, path, type === 'junction' ? 'dir' : type)
    }
  }
})

const { prepareClaudePinnedConfigDir } = await import('./claude-pinned-config-dir')

describe('prepareClaudePinnedConfigDir', () => {
  let root: string
  let hostConfigDir: string
  let hostConfigPath: string
  let pinnedDir: string

  beforeEach(() => {
    fsMock.symlinkTypes = []
    root = mkdtempSync(join(tmpdir(), 'orca-claude-pinned-config-'))
    hostConfigDir = join(root, 'home', '.claude')
    hostConfigPath = join(root, 'home', '.claude.json')
    pinnedDir = join(root, 'claude-accounts', 'acct-b', 'auth')
    mkdirSync(hostConfigDir, { recursive: true })
    mkdirSync(pinnedDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function prepare(platform: NodeJS.Platform = 'darwin', oauthAccount: unknown = null): void {
    prepareClaudePinnedConfigDir({
      configDir: pinnedDir,
      source: { hostConfigDir, hostConfigPath },
      oauthAccount,
      platform
    })
  }

  function readPinnedConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(pinnedDir, '.claude.json'), 'utf-8'))
  }

  it('links projects to the host transcripts, as a junction on Windows', () => {
    prepare('win32')
    const linkPath = join(pinnedDir, 'projects')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(resolve(pinnedDir, readlinkSync(linkPath))).toBe(join(hostConfigDir, 'projects'))
    expect(fsMock.symlinkTypes).toEqual(['junction'])

    prepare('linux')
    expect(fsMock.symlinkTypes).toEqual(['junction'])
  })

  it('never deletes a non-empty real projects dir', () => {
    mkdirSync(join(pinnedDir, 'projects', 'session'), { recursive: true })
    prepare()
    expect(lstatSync(join(pinnedDir, 'projects')).isDirectory()).toBe(true)
    expect(fsMock.symlinkTypes).toEqual([])
  })

  it('repoints a link that targets a stale host dir', () => {
    const stale = join(root, 'stale-projects')
    mkdirSync(stale)
    symlinkSync(stale, join(pinnedDir, 'projects'), 'dir')
    prepare('linux')
    expect(resolve(pinnedDir, readlinkSync(join(pinnedDir, 'projects')))).toBe(
      join(hostConfigDir, 'projects')
    )
  })

  it('mirrors the host settings.json so Orca hooks and the statusline load', () => {
    writeFileSync(join(hostConfigDir, 'settings.json'), '{"hooks":{"Stop":[]}}\n')
    prepare()
    expect(readFileSync(join(pinnedDir, 'settings.json'), 'utf-8')).toBe('{"hooks":{"Stop":[]}}\n')

    writeFileSync(join(hostConfigDir, 'settings.json'), '{"hooks":{}}\n')
    prepare()
    expect(readFileSync(join(pinnedDir, 'settings.json'), 'utf-8')).toBe('{"hooks":{}}\n')
  })

  it('merges first-run keys, trusted projects, and the account without clobbering', () => {
    writeFileSync(
      hostConfigPath,
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.0',
        theme: 'dark',
        numStartups: 99,
        oauthAccount: { emailAddress: 'active@example.com' },
        projects: {
          '/work/trusted': { hasTrustDialogAccepted: true, history: ['secret prompt'] },
          '/work/untrusted': { hasTrustDialogAccepted: false }
        }
      })
    )
    writeFileSync(
      join(pinnedDir, '.claude.json'),
      JSON.stringify({ theme: 'light', projects: { '/work/trusted': { allowedTools: ['x'] } } })
    )

    prepare('darwin', { emailAddress: 'pinned@example.com' })

    expect(readPinnedConfig()).toEqual({
      theme: 'light',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.0',
      projects: {
        '/work/trusted': { allowedTools: ['x'], hasTrustDialogAccepted: true }
      },
      oauthAccount: { emailAddress: 'pinned@example.com' }
    })
  })

  it('leaves an unparseable pinned .claude.json alone', () => {
    writeFileSync(hostConfigPath, JSON.stringify({ hasCompletedOnboarding: true }))
    writeFileSync(join(pinnedDir, '.claude.json'), '{not json')
    prepare('darwin', { emailAddress: 'pinned@example.com' })
    expect(readFileSync(join(pinnedDir, '.claude.json'), 'utf-8')).toBe('{not json')
  })
})
