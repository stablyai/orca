import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { runner } = vi.hoisted(() => ({ runner: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: runner,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (value: string) => value
}))
vi.mock('./status', () => ({ runWithGitReadCacheInvalidation: (run: () => unknown) => run() }))

import { getBranchConflictKind, getBranchConflictKindViaExec } from './repo-branch-conflict'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { GitBinaryTestFixture } from '../../shared/git-binary.test-fixture'

const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
let fixture: GitBinaryTestFixture
let root = ''
let repo = ''

async function git(args: string[], cwd = repo): Promise<{ stdout: string; stderr: string }> {
  return fixture.exec(args, cwd)
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
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-safety-')))
  fixture = new GitBinaryTestFixture(root)
  await fixture.start()
  const { stdout } = await fixture.exec(['--version'])
  expect(stdout).toContain(expectedVersion ? `git version ${expectedVersion}` : 'git version ')
})

afterAll(async () => {
  try {
    await fixture.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

beforeEach(async () => {
  repo = await mkdtemp(join(root, 'repo-'))
  await initializeRepo(repo)
  clearGitCapabilityStateForTests()
  runner.mockImplementation((args: string[], options: { cwd?: string }) => git(args, options.cwd))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
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
