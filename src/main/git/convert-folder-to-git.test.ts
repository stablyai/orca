import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONVERT_GITIGNORE,
  initGitRepoInExistingFolder,
  type ConvertGitOps
} from './convert-folder-to-git'

describe('initGitRepoInExistingFolder (injected ops)', () => {
  function makeOps(overrides: Partial<ConvertGitOps> = {}): {
    ops: ConvertGitOps
    calls: string[][]
  } {
    const calls: string[][] = []
    const ops: ConvertGitOps = {
      exec: vi.fn(async (args: string[]) => {
        calls.push(args)
      }),
      hasGitignore: vi.fn(async () => false),
      writeGitignore: vi.fn(async () => {}),
      ...overrides
    }
    return { ops, calls }
  }

  it('runs init, writes a .gitignore when missing, stages, then commits', async () => {
    const { ops, calls } = makeOps()

    const result = await initGitRepoInExistingFolder(ops)

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      ['init'],
      ['add', '-A'],
      ['commit', '--allow-empty', '-m', 'Initial commit']
    ])
    expect(ops.writeGitignore).toHaveBeenCalledWith(DEFAULT_CONVERT_GITIGNORE)
  })

  it('does not overwrite an existing .gitignore', async () => {
    const { ops } = makeOps({ hasGitignore: vi.fn(async () => true) })

    const result = await initGitRepoInExistingFolder(ops)

    expect(result).toEqual({ ok: true })
    expect(ops.writeGitignore).not.toHaveBeenCalled()
  })

  it('reports the init step on init failure', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'init') {
        throw new Error('git not found')
      }
    })
    const { ops } = makeOps({ exec })

    const result = await initGitRepoInExistingFolder(ops)

    expect(result).toMatchObject({ ok: false, step: 'init', isIdentityError: false })
  })

  it('flags a missing-identity commit failure', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'commit') {
        throw new Error('Author identity unknown\n\n*** Please tell me who you are.')
      }
    })
    const { ops } = makeOps({ exec })

    const result = await initGitRepoInExistingFolder(ops)

    expect(result).toMatchObject({ ok: false, step: 'commit', isIdentityError: true })
  })

  it('does not flag a non-identity commit failure', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'commit') {
        throw new Error('some unrelated commit failure')
      }
    })
    const { ops } = makeOps({ exec })

    const result = await initGitRepoInExistingFolder(ops)

    expect(result).toMatchObject({ ok: false, step: 'commit', isIdentityError: false })
  })
})

describe('initGitRepoInExistingFolder (real git, regression for unborn-HEAD worktrees)', () => {
  let tmpDir: string
  let repoDir: string

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-convert-'))
    repoDir = path.join(tmpDir, 'project')
    mkdirSync(repoDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('commits real files, keeps .env out, and leaves a base commit a worktree can branch from', async () => {
    writeFileSync(path.join(repoDir, 'index.js'), 'console.log("hi")\n')
    writeFileSync(path.join(repoDir, '.env'), 'SECRET=should-not-be-committed\n')

    const result = await initGitRepoInExistingFolder({
      // Pin an identity so the commit succeeds regardless of the host's global config.
      exec: async (args) =>
        void git(repoDir, [
          '-c',
          'user.email=test@orca.dev',
          '-c',
          'user.name=Orca Test',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.excludesFile=',
          ...args
        ]),
      hasGitignore: async () => existsSync(path.join(repoDir, '.gitignore')),
      writeGitignore: async (content) => writeFileSync(path.join(repoDir, '.gitignore'), content)
    })

    expect(result).toEqual({ ok: true })

    const tracked = git(repoDir, ['ls-files']).split('\n').filter(Boolean)
    expect(tracked).toContain('index.js')
    expect(tracked).toContain('.gitignore')
    expect(tracked).not.toContain('.env')

    // A real commit exists (no unborn HEAD) — this is what previously failed
    // worktree base-ref resolution.
    expect(() => git(repoDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).not.toThrow()

    // And a worktree can actually be created from it.
    const worktreePath = path.join(tmpDir, 'wt')
    expect(() =>
      git(repoDir, ['worktree', 'add', '--no-track', '-b', 'feature', worktreePath, 'HEAD'])
    ).not.toThrow()
    expect(existsSync(path.join(worktreePath, 'index.js'))).toBe(true)
  })
})
