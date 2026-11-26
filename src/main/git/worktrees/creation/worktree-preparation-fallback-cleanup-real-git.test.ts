import type * as FilePromises from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/creation/create-preparation'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache
} from '../../command-runner/host-routing/git-capability-state'
import * as runner from '../../command-runner/git-exec-file'
import { prepareWorktreeCreateCheckout } from './worktree-create-preparation'
import {
  startPreparation,
  listPreparations,
  _resetPreparationPoolForTests
} from '../../../workspaces/creation/preparation/worktree-create-preparation-pool'
import { resetPendingPreparationDiscardsForTests } from '../../../workspaces/creation/preparation/worktree-preparation-discard-retry'

const lockWrite = vi.hoisted((): { after: (() => void) | undefined } => ({ after: undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FilePromises>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args)
      if (String(args[0]).endsWith('locked')) {
        lockWrite.after?.()
      }
    }
  }
})

const roots: string[] = []

beforeEach(() => {
  clearGitCapabilityStateForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  lockWrite.after = undefined
  await _resetPreparationPoolForTests()
  clearGitCapabilityStateForTests()
  // Bun ignores rm maxRetries; removeTree retries the whole pass itself.
  await Promise.all(roots.splice(0).map((root) => removeTree(root)))
})

// Fixture setup spawns git directly: worker-thread spawns cost seconds each when cold under Bun.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-fallback-cleanup-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const prepared = join(root, 'prepared')
  git(root, ['init', '--quiet', repo])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await writeFile(join(repo, 'tracked.txt'), 'original\n')
  git(repo, ['add', 'tracked.txt'])
  git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'initial'
  ])
  return { repo, prepared }
}

// Cold node:child_process spawns inside a Bun worker thread cost seconds each; this first test pays for all of them.
it('preserves a pre-existing empty target if its cached fallback lock-path probe fails', async () => {
  const { repo, prepared } = await fixture()
  await mkdir(prepared)
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  const failure = new Error('pre-existing target lock path unavailable')
  const run = runner.gitExecFileAsync
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (options?.cwd === prepared && args.includes('--git-path')) {
      throw failure
    }
    return run(args, options)
  })
  await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', 'reason')).rejects.toBe(
    failure
  )
  expect(existsSync(join(prepared, '.git'))).toBe(true)
  // Git prints worktree paths with forward slashes on Windows.
  const gitPath = prepared.split(sep).join('/')
  expect((await run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).toContain(gitPath)
}, 90_000)

it('removes its completed fallback lock when cancellation arrives during the filesystem write', async () => {
  const { repo, prepared } = await fixture()
  const controller = new AbortController()
  const failure = new Error('canceled while lock write completes')
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  lockWrite.after = () => controller.abort(failure)
  await expect(
    prepareWorktreeCreateCheckout(
      repo,
      prepared,
      'main',
      createWorktreePreparationLockReason('completed-lock'),
      { signal: controller.signal }
    )
  ).rejects.toBe(failure)
  expect(existsSync(prepared)).toBe(false)
  // Git prints worktree paths with forward slashes on Windows; a backslash needle never matches.
  expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
    prepared.split(sep).join('/')
  )
})

it('discards a ready available checkout when its preparation caller cancels', async () => {
  const { repo } = await fixture()
  const controller = new AbortController()
  await startPreparation({
    repoPath: repo,
    workspaceRoot: join(repo, '..'),
    baseBranch: 'main',
    canonicalBase: 'refs/heads/main',
    options: { signal: controller.signal }
  })
  const [entry] = listPreparations()
  controller.abort()
  await vi.waitFor(() => expect(existsSync(entry.preparedPath)).toBe(false), { timeout: 5000 })
  // Why the unregister rides a background discard: dir removal alone races the worktree admin cleanup.
  await resetPendingPreparationDiscardsForTests()
  // Git prints worktree paths with forward slashes on Windows; a backslash needle never matches.
  expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
    entry.preparedPath.split(sep).join('/')
  )
})
