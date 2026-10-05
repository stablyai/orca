import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('./runner', () => ({ gitExecFileAsync: vi.fn(), gitExecFileSync: vi.fn() }))
vi.mock('./local-repo-ref-maintenance', () => ({
  withRepoRefMaintenancePaused: (_reason: string, run: () => unknown) => run()
}))

import { forceDeleteLocalBranch } from './worktree-branch-removal'
import { forceDeletePreservedRelayBranch } from '../../relay/git-handler-branch-cleanup'

const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY ?? 'git'
const dockerUser =
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []
let root = ''
let repo = ''
let checkout = ''

async function git(args: string[], cwd = repo): Promise<{ stdout: string; stderr: string }> {
  const result = await runProcess({
    program: image ? 'docker' : binary,
    args: image
      ? [
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
        ]
      : args,
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(root, 'empty-config'),
      GIT_CONFIG_NOSYSTEM: '1'
    },
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), { code: result.code, stderr: result.stderr })
  }
  return result
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-rebase-reservation-')))
  repo = join(root, 'repo')
  checkout = join(root, 'checkout')
  await mkdir(repo)
  await writeFile(join(root, 'empty-config'), '')
  await git(['init', '-q'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [key, value] of [
    ['user.name', 'Reservation Safety'],
    ['user.email', 'safety@example.invalid'],
    ['commit.gpgSign', 'false'],
    ['core.hooksPath', '.git/no-hooks'],
    ['gc.auto', '0']
  ]) {
    await git(['config', key, value])
  }
  await writeFile(join(repo, 'seed'), 'seed\n')
  await git(['add', 'seed'])
  await git(['commit', '-qm', 'seed'])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('rebase branch reservations with real Git', () => {
  it.for(['native', 'relay'] as const)(
    '%s retains auxiliary branches reserved by a paused real rebase --update-refs',
    { timeout: 120_000 },
    async (host, context) => {
      await git(['worktree', 'add', '-q', '-b', 'feature', checkout])
      await writeFile(join(checkout, 'first'), 'first\n')
      await git(['add', 'first'], checkout)
      await git(['commit', '-qm', 'first'], checkout)
      await git(['branch', 'auxiliary'], checkout)
      const expected = (await git(['rev-parse', 'refs/heads/auxiliary'])).stdout.trim()
      await writeFile(join(checkout, 'second'), 'second\n')
      await git(['add', 'second'], checkout)
      await git(['commit', '-qm', 'second'], checkout)
      await writeFile(join(repo, 'base'), 'advanced main\n')
      await git(['add', 'base'])
      await git(['commit', '-qm', 'advance main'])
      try {
        await git(['rebase', '--update-refs', '--exec', 'false', 'main'], checkout)
        throw new Error('Rebase did not pause')
      } catch (error) {
        if (error instanceof Error && /unknown option[^\n]*update-refs/.test(error.message)) {
          context.skip()
        }
        if (!(error instanceof Error) || !/execution failed/.test(error.message)) {
          throw error
        }
      }
      const gitDir = (await git(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim()
      expect(await readFile(join(gitDir, 'rebase-merge', 'update-refs'), 'utf8')).toContain(
        'refs/heads/auxiliary\n'
      )
      await expect(git(['branch', '-D', 'auxiliary'])).rejects.toThrow(
        /checked out|used by worktree/
      )
      const cleanupGit = vi.fn((args: string[], cwd: string) => git(args, cwd))
      const remove = () =>
        host === 'native'
          ? forceDeleteLocalBranch(repo, 'auxiliary', expected, cleanupGit)
          : forceDeletePreservedRelayBranch(cleanupGit, repo, 'auxiliary', expected)
      await expect(remove()).rejects.toThrow('checked out in another worktree')
      expect(cleanupGit.mock.calls.map(([args]) => args)).toEqual([
        ['worktree', 'list', '--porcelain']
      ])
      expect((await git(['rev-parse', 'refs/heads/auxiliary'])).stdout.trim()).toBe(expected)
      await git(['rebase', '--abort'], checkout)
      await expect(remove()).resolves.toBeUndefined()
    }
  )
})
