import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeProjectsRootDirs } from './session-scanner-roots'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import {
  claudeProjectsDirForWslHome,
  extraWslClaudeProjectsDirs,
  resetWslClaudeProjectsRootCacheForTests,
  resolveWslClaudeProjectsDir
} from './wsl-claude-projects-root'

const UNREADABLE_SYMLINK =
  'WSL ~/.claude is a symlink Windows cannot follow, and the resolved projects directory is not readable.'

let tempRoots: string[] = []

afterEach(async () => {
  resetWslClaudeProjectsRootCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function wslHome(name: string): string {
  return `\\\\wsl.localhost\\Ubuntu\\home\\${name}`
}

describe('WSL Claude projects behind a symlink Windows cannot follow', () => {
  it('lists the session from the resolved projects directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-wsl-claude-link-'))
    tempRoots.push(root)
    const projectsDir = join(root, 'dotfiles', '.claude', 'projects')
    await mkdir(join(projectsDir, 'repo'), { recursive: true })
    await writeFile(
      join(projectsDir, 'repo', 'claude-link.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-link',
          timestamp: '2026-06-10T10:00:00.000Z',
          cwd: '/home/ada/repo',
          message: { role: 'user', content: 'Claude behind a WSL symlink' }
        }
      ])
    )
    const wslHome = '\\\\wsl.localhost\\Ubuntu\\home\\ada'

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      claudeProfileProjectsDirs: [],
      wslHomeDirs: [wslHome],
      platform: 'win32',
      resolveWslClaudeProjectsDir: async (homeDir) => (homeDir === wslHome ? projectsDir : null)
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toContain('claude-link')
  })
})

describe('resolveWslClaudeProjectsDir', () => {
  it('ignores a home that is not a WSL UNC path', async () => {
    let reads = 0
    const found = await resolveWslClaudeProjectsDir({
      homeDir: '/home/ada',
      platform: 'win32',
      readRealpath: async () => {
        reads += 1
        return '/home/ada/dotfiles/.claude/projects'
      }
    })
    expect(found).toEqual({ rootDir: null, issue: null })
    expect(reads).toBe(0)
  })

  it('does not call wsl when the logical projects directory is already readable', async () => {
    const home = wslHome('direct')
    const direct = claudeProjectsDirForWslHome(home)
    let reads = 0
    const found = await resolveWslClaudeProjectsDir({
      homeDir: home,
      platform: 'win32',
      directoryExists: async (path) => path === direct,
      readRealpath: async () => {
        reads += 1
        return '/home/ada/dotfiles/.claude/projects'
      }
    })
    expect(found).toEqual({ rootDir: null, issue: null })
    expect(reads).toBe(0)
    expect(direct).toBe('\\\\wsl.localhost\\Ubuntu\\home\\direct\\.claude\\projects')
  })

  it('maps a symlink target to the UNC path Windows can read', async () => {
    const home = wslHome('linked')
    const calls: [string, string][] = []
    const found = await resolveWslClaudeProjectsDir({
      homeDir: home,
      platform: 'win32',
      directoryExists: async (path) =>
        path === '\\\\wsl.localhost\\Ubuntu\\home\\linked\\dotfiles\\.claude\\projects',
      readRealpath: async (distro, linuxPath) => {
        calls.push([distro, linuxPath])
        return '/home/linked/dotfiles/.claude/projects/'
      }
    })
    expect(calls).toEqual([['Ubuntu', '/home/linked/.claude/projects']])
    expect(found).toEqual({
      rootDir: '\\\\wsl.localhost\\Ubuntu\\home\\linked\\dotfiles\\.claude\\projects',
      issue: null
    })
  })

  it('stays quiet when readlink resolves to the same projects path', async () => {
    const home = wslHome('plain')
    const found = await resolveWslClaudeProjectsDir({
      homeDir: home,
      platform: 'win32',
      directoryExists: async () => false,
      readRealpath: async () => '/home/plain/.claude/projects'
    })
    expect(found).toEqual({ rootDir: null, issue: null })
  })

  it('reports an issue when the resolved projects directory is not readable', async () => {
    const home = wslHome('broken')
    const found = await resolveWslClaudeProjectsDir({
      homeDir: home,
      platform: 'win32',
      directoryExists: async () => false,
      readRealpath: async () => '/home/broken/dotfiles/.claude/projects'
    })
    expect(found.rootDir).toBeNull()
    expect(found.issue).toEqual({
      path: claudeProjectsDirForWslHome(home),
      message: UNREADABLE_SYMLINK
    })
  })

  it('does not launch wsl.exe on a non-Windows host', async () => {
    const found = await resolveWslClaudeProjectsDir({
      homeDir: wslHome('darwin'),
      platform: 'darwin'
    })
    expect(found).toEqual({ rootDir: null, issue: null })
  })

  it('remembers a resolved directory and a non-symlink, and retries an unreadable target', async () => {
    const resolvedHome = wslHome('cached-hit')
    const plainHome = wslHome('cached-plain')
    const brokenHome = wslHome('cached-miss')
    const resolvedUnc = '\\\\wsl.localhost\\Ubuntu\\home\\cached-hit\\dotfiles\\.claude\\projects'
    let resolvedReads = 0
    let plainReads = 0
    let brokenReads = 0
    const resolved = {
      homeDir: resolvedHome,
      platform: 'win32' as const,
      useProcessCache: true,
      directoryExists: async (path: string) => path === resolvedUnc,
      readRealpath: async () => {
        resolvedReads += 1
        return '/home/cached-hit/dotfiles/.claude/projects'
      }
    }
    const plain = {
      homeDir: plainHome,
      platform: 'win32' as const,
      useProcessCache: true,
      directoryExists: async () => false,
      readRealpath: async () => {
        plainReads += 1
        return '/home/cached-plain/.claude/projects'
      }
    }
    const broken = {
      homeDir: brokenHome,
      platform: 'win32' as const,
      useProcessCache: true,
      directoryExists: async () => false,
      readRealpath: async () => {
        brokenReads += 1
        return '/home/cached-miss/dotfiles/.claude/projects'
      }
    }
    expect(await resolveWslClaudeProjectsDir(resolved)).toEqual({
      rootDir: resolvedUnc,
      issue: null
    })
    expect(await resolveWslClaudeProjectsDir(resolved)).toEqual({
      rootDir: resolvedUnc,
      issue: null
    })
    expect(await resolveWslClaudeProjectsDir(plain)).toEqual({ rootDir: null, issue: null })
    expect(await resolveWslClaudeProjectsDir(plain)).toEqual({ rootDir: null, issue: null })
    expect((await resolveWslClaudeProjectsDir(broken)).issue?.message).toBe(UNREADABLE_SYMLINK)
    expect((await resolveWslClaudeProjectsDir(broken)).issue?.message).toBe(UNREADABLE_SYMLINK)
    expect(resolvedReads).toBe(1)
    expect(plainReads).toBe(1)
    expect(brokenReads).toBe(2)
  })

  it('prefers a logical directory that appears after a symlink was cached', async () => {
    const home = wslHome('replaced')
    const direct = claudeProjectsDirForWslHome(home)
    let directExists = false
    let reads = 0
    const args = {
      homeDir: home,
      platform: 'win32' as const,
      useProcessCache: true,
      directoryExists: async (path: string) =>
        path === '\\\\wsl.localhost\\Ubuntu\\home\\replaced\\dotfiles\\.claude\\projects' ||
        (path === direct && directExists),
      readRealpath: async () => {
        reads += 1
        return '/home/replaced/dotfiles/.claude/projects'
      }
    }
    expect((await resolveWslClaudeProjectsDir(args)).rootDir).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\replaced\\dotfiles\\.claude\\projects'
    )
    directExists = true
    expect(await resolveWslClaudeProjectsDir(args)).toEqual({ rootDir: null, issue: null })
    expect(reads).toBe(1)
  })
})

describe('extra WSL Claude projects directories', () => {
  it('adds nothing for a non-Windows host', async () => {
    const found = await extraWslClaudeProjectsDirs({
      wslHomeDirs: [wslHome('idle'), '/home/local'],
      platform: 'darwin'
    })
    expect(found).toEqual({ dirs: [], issues: [] })
  })

  it('uses an injected projects directory without raising an issue', async () => {
    const injected = await extraWslClaudeProjectsDirs({
      wslHomeDirs: [wslHome('issue')],
      platform: 'win32',
      resolveWslClaudeProjectsDir: async () => '/tmp/claude-projects'
    })
    expect(injected).toEqual({ dirs: ['/tmp/claude-projects'], issues: [] })
  })

  it('includes the resolved projects directory in the Claude scan roots', () => {
    const extra = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\dotfiles\\.claude\\projects'
    expect(
      claudeProjectsRootDirs({
        claudeProjectsDir: '/scan/projects',
        wslHomeDirs: [],
        claudeProfileProjectsDirs: [],
        extraClaudeProjectsDirs: [extra]
      })
    ).toEqual(['/scan/projects', extra])
  })
})
