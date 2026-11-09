import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as runner from './runner'
import {
  getGitRepoRoot,
  getLinkedWorktreeMainRepoRoot,
  inspectGitRepoForRegistration
} from './repo-detection'

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
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
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

  it('resolves linked checkout ownership with newlines in the root and common directory', () => {
    const repo = join(directory, 'main\n\nrepo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
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
