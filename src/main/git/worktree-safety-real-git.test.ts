import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { runner } = vi.hoisted(() => ({ runner: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: runner,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (value: string) => value
}))
vi.mock('./status', () => ({ runWithGitReadCacheInvalidation: (run: () => unknown) => run() }))

import { getBranchConflictKind, getBranchConflictKindViaExec } from './repo-branch-conflict'
import { clearGitCapabilityStateForTests } from './git-capability-state'

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
  await initializeRepo(repo)
  clearGitCapabilityStateForTests()
  runner.mockImplementation((args: string[], options: { cwd?: string }) => git(args, options.cwd))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('worktree safety with the real Git binary', () => {

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

})
