import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { isWorktreeCreatePreparation } from '../../shared/worktree/create-preparation'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import { annotateWorktreeLocksFromAdmin } from '../../shared/git-worktree-admin'
import type { GitExec } from '../../relay/git-handler-ops'

const { runner } = vi.hoisted(() => ({ runner: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: runner,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (value: string) => value
}))
vi.mock('./status', () => ({ runWithGitReadCacheInvalidation: (run: () => unknown) => run() }))

import { removeWorktree } from './worktree-removal'
import { forceDeleteLocalBranch } from './worktree-branch-removal'
import { readWorktreeList } from './worktree-list-reader'
import { getBranchConflictKind, getBranchConflictKindViaExec } from './repo-branch-conflict'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { removeWorktreeOp } from '../../relay/git-handler-worktree-remove'
import { forceDeletePreservedRelayBranch } from '../../relay/git-handler-branch-cleanup'
import { readRelayWorktreeList } from '../../relay/git-handler-worktree-list'

const execFileAsync = promisify(execFile)
const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY ?? 'git'
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const dockerUser =
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []
let root = ''
let repo = ''
let checkout = ''

async function git(args: string[], cwd = repo): Promise<{ stdout: string; stderr: string }> {
  return image
    ? execFileAsync(
        'docker',
        [
          'run',
          '--rm',
          '--network=none',
          ...dockerUser,
          '-v',
          `${root}:${root}`,
          '-w',
          cwd,
          image,
          '-c',
          `safe.directory=${cwd}`,
          ...args
        ],
        { maxBuffer: 2 * 1024 * 1024 }
      )
    : execFileAsync(binary, args, {
        cwd,
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
        maxBuffer: 2 * 1024 * 1024
      })
}

const relay: GitExec = (args, cwd) => git(args, cwd)

async function initializeRepo(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await git(['init', '-q', '-b', 'main'], cwd).catch(() => git(['init', '-q'], cwd))
  await git(['config', 'user.name', 'Worktree Safety'], cwd)
  await git(['config', 'user.email', 'safety@example.invalid'], cwd)
  await git(['config', 'commit.gpgSign', 'false'], cwd)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], cwd)
  await git(['config', 'gc.auto', '0'], cwd)
  await writeFile(join(cwd, 'seed'), 'seed\n')
  await git(['add', 'seed'], cwd)
  await git(['commit', '-qm', 'seed'], cwd)
}

beforeAll(async () => {
  const { stdout } = await execFileAsync(
    image ? 'docker' : binary,
    image ? ['run', '--rm', '--network=none', ...dockerUser, image, '--version'] : ['--version']
  )
  expect(stdout).toContain(expectedVersion ? `git version ${expectedVersion}` : 'git version ')
})

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-safety-')))
  repo = join(root, 'repo')
  checkout = join(root, 'checkout')
  await initializeRepo(repo)
  clearGitCapabilityStateForTests()
  runner.mockImplementation((args: string[], options: { cwd?: string }) => git(args, options.cwd))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('worktree safety with the real Git binary', () => {
  it.each(['native', 'relay'] as const)(
    '%s preserves unpublished submodule objects without implicit force',
    async (host) => {
      const origin = join(root, 'sub-origin')
      await initializeRepo(origin)
      await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'sub'])
      await git(['commit', '-qam', 'submodule'])
      await git(['worktree', 'add', '-q', '-b', 'feature', checkout])
      await git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], checkout)
      const sub = join(checkout, 'sub')
      await git(['checkout', '-qb', 'unpublished'], sub)
      await writeFile(join(sub, 'local'), 'unpublished work\n')
      await git(['add', 'local'], sub)
      await git(
        [
          '-c',
          'user.name=Safety',
          '-c',
          'user.email=safety@example.invalid',
          '-c',
          'commit.gpgSign=false',
          'commit',
          '-qm',
          'local'
        ],
        sub
      )
      const local = (await git(['rev-parse', 'HEAD'], sub)).stdout.trim()
      await git(['checkout', '--detach', 'HEAD~1'], sub)
      expect(
        (await git(['status', '--porcelain', '--ignore-submodules=none'], checkout)).stdout
      ).toBe('')

      const remove = (force: boolean) =>
        host === 'native'
          ? removeWorktree(repo, checkout, force, {
              deleteBranch: false,
              knownRemovedWorktree: { branch: 'refs/heads/feature', head: '', locked: false }
            })
          : removeWorktreeOp(
              relay,
              { worktreePath: checkout, force, deleteBranch: false },
              new GitCapabilityCache()
            )
      await expect(remove(false)).rejects.toThrow(/submodules cannot be moved or removed/)
      expect((await git(['cat-file', '-t', local], sub)).stdout.trim()).toBe('commit')
      expect((await git(['worktree', 'list', '--porcelain'])).stdout).toContain(checkout)
      await expect(remove(true)).resolves.toEqual({})
      await expect(readFile(join(checkout, '.git'))).rejects.toThrow()
    },
    120_000
  )

  it.each(['native', 'relay'] as const)(
    '%s reads preparation ownership from admin metadata on old porcelain',
    async (host) => {
      await git(['worktree', 'add', '-q', '--detach', checkout])
      const reason = 'orca-create-preparation:v1:12345:retained'
      await git(['worktree', 'lock', '--reason', reason, checkout])
      const oldList = (await git(['worktree', 'list', '--porcelain'])).stdout
        .split('\n')
        .filter((line) => !line.startsWith('locked'))
        .join('\n')
      const capabilities = new GitCapabilityCache()
      capabilities.rememberUnsupported('worktree-list-z')
      runner.mockImplementation(async (args: string[], options: { cwd?: string }) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          if (args.includes('-z')) {
            throw Object.assign(new Error("unknown switch `z'"), {
              code: 129,
              stderr: "error: unknown switch `z'"
            })
          }
          return { stdout: oldList, stderr: '' }
        }
        return git(args, options.cwd)
      })
      const entries =
        host === 'native'
          ? await readWorktreeList(repo)
          : await readRelayWorktreeList((args, cwd) => runner(args, { cwd }), repo, capabilities)
      const prepared = entries.find((entry) => entry.path === checkout)
      expect(prepared).toMatchObject({ locked: true, lockReason: reason })
      expect(prepared && isWorktreeCreatePreparation(prepared)).toBe(true)
      await rm(checkout, { recursive: true })
      const annotated = await annotateWorktreeLocksFromAdmin(repo, parseWorktreeList(oldList))
      expect(annotated.find((entry) => entry.path === checkout)).toMatchObject({
        locked: true,
        lockReason: reason
      })
    },
    90_000
  )

  it.each([
    ['feature', 'Feature'],
    ['Ä', 'ä'],
    ['K', 'K'],
    ['ß', 'ẞ']
  ])(
    'protects packed %s from the alias %s on native and SSH hosts',
    async (existing, candidate) => {
      await git(['branch', existing])
      await git(['pack-refs', '--all'])
      const before = (await git(['rev-parse', `refs/heads/${existing}`])).stdout
      await writeFile(join(repo, 'seed'), 'advanced base\n')
      await git(['commit', '-qam', 'advance'])
      for (const setting of ['true', 'false', 'unset']) {
        await git(
          setting === 'unset'
            ? ['config', '--unset', 'core.ignoreCase']
            : ['config', 'core.ignoreCase', setting]
        )
        await expect(getBranchConflictKind(repo, candidate)).resolves.toBe('local')
        await expect(getBranchConflictKindViaExec((args) => git(args), candidate)).resolves.toBe(
          'local'
        )
        expect((await git(['rev-parse', `refs/heads/${existing}`])).stdout).toBe(before)
      }
    },
    90_000
  )

  it.each(['native', 'relay'] as const)(
    '%s retains detached branches reserved by rebase or bisect',
    async (host) => {
      await git(['worktree', 'add', '-q', '-b', 'feature', checkout])
      const expected = (await git(['rev-parse', 'refs/heads/feature'])).stdout.trim()
      await git(['checkout', '--detach'], checkout)
      const gitDir = (await git(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim()
      const remove = () =>
        host === 'native'
          ? forceDeleteLocalBranch(repo, 'feature', expected, git)
          : forceDeletePreservedRelayBranch(relay, repo, 'feature', expected)
      for (const marker of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
        const file = join(gitDir, ...marker.split('/'))
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, marker === 'BISECT_START' ? 'feature\n' : 'refs/heads/feature\n')
        if (marker === 'BISECT_START') {
          await writeFile(join(gitDir, 'BISECT_LOG'), '')
        }
        await expect(git(['branch', '-D', 'feature'])).rejects.toThrow(
          /checked out|used by worktree/
        )
        await expect(remove()).rejects.toThrow('checked out in another worktree')
        expect((await git(['rev-parse', 'refs/heads/feature'])).stdout.trim()).toBe(expected)
        await rm(file)
        if (marker === 'BISECT_START') {
          await rm(join(gitDir, 'BISECT_LOG'))
        }
      }
      await expect(remove()).resolves.toBeUndefined()
    },
    120_000
  )
  it.each(['native', 'relay'] as const)(
    '%s restores a deleted ref when detached branch use starts during deletion',
    async (host) => {
      await git(['worktree', 'add', '-q', '-b', 'feature', checkout])
      const expected = (await git(['rev-parse', 'refs/heads/feature'])).stdout.trim()
      await git(['checkout', '--detach'], checkout)
      const gitDir = (await git(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim()
      const racingGit = async (args: string[], cwd: string) => {
        const result = await git(args, cwd)
        if (args[0] === 'update-ref' && args[1] === '-d') {
          await writeFile(join(gitDir, 'BISECT_START'), 'feature\n')
        }
        return result
      }
      const remove = () =>
        host === 'native'
          ? forceDeleteLocalBranch(repo, 'feature', expected, racingGit)
          : forceDeletePreservedRelayBranch(racingGit, repo, 'feature', expected)
      await expect(remove()).rejects.toThrow('checked out in another worktree')
      expect((await git(['rev-parse', 'refs/heads/feature'])).stdout.trim()).toBe(expected)
    },
    90_000
  )
})
