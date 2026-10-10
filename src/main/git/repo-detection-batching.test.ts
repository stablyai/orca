import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as runner from './runner'
import {
  getGitRepoRoot,
  getLinkedWorktreeMainRepoRoot,
  inspectGitRepoForRegistration,
  isGitRepo
} from './repo-detection'
import { configureRealGitTestRepo } from './real-git-test-repo'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

describe('repository registration probe batching', () => {
  let directory: string
  let repo: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-repo-probe-count-'))
    repo = join(directory, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
    configureRealGitTestRepo(repo)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('answers registration validity, root and main-checkout identity with two probes', () => {
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    expect(inspectGitRepoForRegistration(repo)).toEqual({
      isRepo: true,
      rootPath: git(repo, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/'),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps linked main-checkout resolution lazy and reuses its metadata', () => {
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    const linked = join(directory, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    const inspected = inspectGitRepoForRegistration(linked)
    expect(inspected.isRepo).toBe(true)
    expect(inspected.rootPath).toBe(
      git(linked, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')
    )
    expect(inspected.mainRepoPath).toBe(realpathSync(repo))
    expect(probe).toHaveBeenCalledTimes(2)
    if (!inspected.mainRepoPath) {
      throw new Error('Linked checkout did not identify its main checkout')
    }
    expect(getGitRepoRoot(inspected.mainRepoPath)).toBe(
      git(repo, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')
    )
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('reads root and linked-main metadata together when a symlink changes between probes', () => {
    const linked = join(directory, 'linked')
    const alias = join(directory, 'alias')
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const execute = runner.gitExecFileSync
    const probe = vi.spyOn(runner, 'gitExecFileSync').mockImplementation((args, options) => {
      const output = execute(args, options)
      if (probe.mock.calls.length === 1) {
        rmSync(alias)
        symlinkSync(linked, alias, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return output
    })
    expect(inspectGitRepoForRegistration(alias)).toEqual({
      isRepo: true,
      rootPath: git(linked, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/'),
      mainRepoPath: realpathSync(repo)
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('identifies a bare repository without requesting a worktree root', () => {
    const bare = join(directory, 'bare.git')
    git(directory, ['init', '--bare', '-q', bare])
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    expect(inspectGitRepoForRegistration(bare)).toEqual({
      isRepo: true,
      rootPath: bare,
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0][0]).not.toContain('--show-toplevel')
  })

  it('rejects an administrative directory after one clean negative pair', () => {
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    const admin = join(repo, '.git')
    expect(inspectGitRepoForRegistration(admin)).toEqual({
      isRepo: false,
      rootPath: admin,
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not repeat a failed Git discovery before using the marker fallback', () => {
    const nested = join(repo, 'packages', 'web')
    mkdirSync(nested, { recursive: true })
    const probe = vi.spyOn(runner, 'gitExecFileSync').mockImplementation(() => {
      throw new Error('Git could not run')
    })
    expect(inspectGitRepoForRegistration(nested)).toEqual({
      isRepo: true,
      rootPath: repo.replace(/\\/g, '/'),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('uses one boolean query for bare checks and none for a missing path', () => {
    const bare = join(directory, 'bare.git')
    git(directory, ['init', '--bare', '-q', bare])
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    expect(isGitRepo(bare)).toBe(true)
    expect(probe).toHaveBeenCalledOnce()
    expect(inspectGitRepoForRegistration(join(directory, 'missing')).isRepo).toBe(false)
    expect(probe).toHaveBeenCalledOnce()
  })
})

// Windows rejects control characters in directory names.
describe.skipIf(process.platform === 'win32')('repository paths with newlines', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-repo-newline-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['repo\nname', 'repo\n\nname', ' repo name ', 'repo\n'])(
    'preserves the complete root %j instead of registering a prefix repository',
    (name) => {
      const prefixRepo = join(directory, 'repo')
      mkdirSync(prefixRepo)
      git(prefixRepo, ['init', '-q'])
      const repo = join(directory, name)
      const nested = join(repo, 'nested')
      mkdirSync(nested, { recursive: true })
      git(repo, ['init', '-q'])
      expect(getGitRepoRoot(nested)).toBe(realpathSync(repo))
      expect(inspectGitRepoForRegistration(nested)).toEqual({
        isRepo: true,
        rootPath: realpathSync(repo),
        mainRepoPath: null
      })
    }
  )

  it('preserves an external Git directory containing a newline', () => {
    const repo = join(directory, 'repo')
    const admin = join(directory, 'external\nadmin')
    mkdirSync(repo)
    git(repo, ['init', '-q', '--separate-git-dir', admin])
    const probe = vi.spyOn(runner, 'gitExecFileSync')
    expect(inspectGitRepoForRegistration(repo)).toEqual({
      isRepo: true,
      rootPath: realpathSync(repo),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledTimes(5)
    expect(probe.mock.calls.map(([args]) => args)).toContainEqual(['rev-parse', '--git-dir'])
    expect(probe.mock.calls.map(([args]) => args)).toContainEqual(['rev-parse', '--git-common-dir'])
    expect(getLinkedWorktreeMainRepoRoot(repo)).toBeNull()
  })

  it('resolves linked checkout ownership with newlines in the root and common directory', () => {
    const repo = join(directory, 'main\n\nrepo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
    configureRealGitTestRepo(repo)
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    const linked = join(directory, 'linked\nrepo')
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    expect(inspectGitRepoForRegistration(linked)).toEqual({
      isRepo: true,
      rootPath: realpathSync(linked),
      mainRepoPath: realpathSync(repo)
    })
    expect(getLinkedWorktreeMainRepoRoot(linked)).toBe(realpathSync(repo))
  })
})
