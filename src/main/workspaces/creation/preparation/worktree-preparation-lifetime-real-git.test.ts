import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import * as gitRunner from '../../../git/command-runner/git-exec-file'
import { createRuntimeLocalGitWorktree } from '../../../runtime/workspaces/creation/runtime-local-git-worktree-create'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { _resetWorktreeCreatePreparationsForTests } from './worktree-create-preparation'
import {
  discardRepoPreparations,
  listPreparations,
  startPreparation
} from './worktree-create-preparation-pool'

const roots: string[] = []
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-preparation-lifetime-')))
  roots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test User')
  git(repoPath, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repoPath, 'version.txt'), 'original\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '--quiet', '-m', 'initial')
  const repo = {
    id: 'lifetime-repo',
    path: repoPath,
    displayName: 'Repo',
    addedAt: 0,
    badgeColor: ''
  }
  const arm = (
    beforeMaterialization?: Promise<void>,
    options: AddWorktreeOptions = {},
    baseBranch = 'main'
  ) =>
    startPreparation({
      repoPath,
      workspaceRoot: root,
      baseBranch,
      canonicalBase: baseBranch === 'origin/main' ? 'refs/remotes/origin/main' : 'refs/heads/main',
      options,
      beforeMaterialization
    })
  const create = async (
    branch: string,
    baseBranch = 'main',
    options: AddWorktreeOptions = {},
    waiting?: () => void,
    timing = createWorktreeCreateTimingRecorder()
  ) => {
    const time = timing.time.bind(timing)
    timing.time = (phase, operation) => {
      if (phase === 'prepared_checkout_wait') {
        waiting?.()
      }
      return time(phase, operation)
    }
    const rearm = { fire: () => {} }
    try {
      return await createRuntimeLocalGitWorktree({
        request: { repoSelector: repo.id, name: branch },
        repo,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no metadata/push/name-retirement operation is requested at this Git-only host boundary.
        store: {} as RuntimeStore,
        settings: {
          workspaceDir: root,
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false
        },
        base: { baseBranch, remoteTrackingBase: null, deferredRefresh: null },
        workspaceRoot: root,
        branchName: branch,
        worktreePath: join(root, branch),
        checkoutExistingBranch: false,
        localWorktreeGitOptions: options,
        // Foreground freshness already completed; the obsolete speculative barrier is independent.
        baseRefRefresh: { finish: async () => {} },
        rearm,
        timing
      })
    } finally {
      timing.finish()
      rearm.fire()
    }
  }
  return { root, repoPath, arm, create }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await _resetWorktreeCreatePreparationsForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['initial', 'queued'])(
  'creates the requested checkout across an unresolved older %s barrier, then creates again',
  async (kind) => {
    const { root, repoPath, arm, create } = await fixture()
    git(repoPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    if (kind === 'queued') {
      await arm(undefined, {}, 'origin/main')
    }
    const barrier = Promise.withResolvers<void>()
    const preparing = arm(barrier.promise, {}, 'origin/main')
    await vi.waitFor(() => expect(listPreparations()).toHaveLength(1))
    const [entry] = listPreparations()
    await vi.waitFor(() => expect(existsSync(join(entry.preparedPath, '.git'))).toBe(true))
    await writeFile(join(repoPath, 'version.txt'), 'requested\n')
    git(repoPath, 'commit', '--quiet', '-am', 'requested tip')
    try {
      const timing = createWorktreeCreateTimingRecorder()
      await create('first', 'main', {}, undefined, timing)
      expect(timing.finish().preparedCheckout).toMatchObject({ status: 'hit', reset: 'retargeted' })
      await preparing
      expect(git(join(root, 'first'), 'branch', '--show-current')).toBe('first')
      expect(await readFile(join(root, 'first', 'version.txt'), 'utf8')).toBe('requested\n')
      await create('second', 'origin/main')
      expect(await readFile(join(root, 'second', 'version.txt'), 'utf8')).toBe('original\n')
      barrier.resolve()
      expect(git(join(root, 'first'), 'status', '--porcelain')).toBe('')
    } finally {
      barrier.resolve()
      await preparing.catch(() => {})
    }
  }
)

it('falls back after an inherited operation expires and never starts the abandoned checkout late', async () => {
  const { root, repoPath, arm, create } = await fixture()
  const blocked = Promise.withResolvers<void>()
  const resetStarted = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  let blockedPath: string | undefined
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('reset') && blockedPath === undefined) {
      blockedPath = options.cwd
      resetStarted.resolve()
      await blocked.promise
    }
    return run(args, options)
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const preparation = arm().catch(() => {})
  await resetStarted.promise
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  const queuedRefresh = arm(Promise.resolve()).catch(() => {})
  const creation = create('fallback', 'main', {}, waiting.resolve)
  await waiting.promise
  // The 38min initial budget already spent 4min; neither claim nor queued refresh renews it.
  await vi.advanceTimersByTimeAsync(34 * 60_000)
  await creation
  expect(await readFile(join(root, 'fallback', 'version.txt'), 'utf8')).toBe('original\n')
  await vi.advanceTimersByTimeAsync(30_000)
  blocked.resolve()
  await preparation
  await queuedRefresh
  await create('after-fallback')
  expect(git(join(root, 'after-fallback'), 'branch', '--show-current')).toBe('after-fallback')
  expect(existsSync(join(blockedPath!, 'version.txt'))).toBe(false)
  expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain('refs/heads/fallback')
})

it('propagates caller cancellation without falling back to a phantom worktree', async () => {
  const { root, arm, create } = await fixture()
  const blocked = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('reset')) {
      started.resolve()
      await blocked.promise
    }
    return run(args, options)
  })
  const preparation = arm().catch(() => {})
  await started.promise
  const controller = new AbortController()
  const creation = create('canceled', 'main', { signal: controller.signal }, waiting.resolve)
  const canceled = expect(creation).rejects.toThrow('caller stopped')
  await waiting.promise
  controller.abort(new Error('caller stopped'))
  await canceled
  blocked.resolve()
  await preparation
  await create('after-cancel')
  expect(existsSync(join(root, 'canceled'))).toBe(false)
  expect(await readFile(join(root, 'after-cancel', 'version.txt'), 'utf8')).toBe('original\n')
})

it('keeps a locked artifact after writer termination cannot be verified, even when proof arrives late', async () => {
  const { root, arm, create } = await fixture()
  const failed = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const terminated = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  let preparedPath = ''
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('reset') && !preparedPath) {
      preparedPath = options.cwd
      options.observeChildTermination?.(terminated.promise, true)
      started.resolve()
      await failed.promise
      throw new Error('writer result rejected before termination proof')
    }
    return run(args, options)
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const preparation = arm().catch(() => {})
  await started.promise
  const creation = create('writer-fallback', 'main', {}, waiting.resolve)
  await waiting.promise
  failed.resolve()
  await creation
  await preparation
  await vi.advanceTimersByTimeAsync(30_000)
  terminated.resolve()
  await create('after-writer')
  expect(await readFile(join(root, 'writer-fallback', 'version.txt'), 'utf8')).toBe('original\n')
  expect(existsSync(join(preparedPath, '.git'))).toBe(true)
  expect(existsSync(join(preparedPath, 'version.txt'))).toBe(false)
  expect(git(preparedPath, 'worktree', 'list', '--porcelain')).toContain(
    'locked orca-create-preparation:'
  )
})

it('never spawns a destructive remove queued beyond retirement abandonment', async () => {
  const { repoPath, arm, create } = await fixture()
  const queued = Promise.withResolvers<void>()
  const admitted = Promise.withResolvers<void>()
  const attempted = Promise.withResolvers<void>()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await arm()
  const [entry] = listPreparations()
  const run = gitRunner.gitExecFileAsync
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove')) {
      queued.resolve()
      await admitted.promise
      try {
        return await run(args, options)
      } finally {
        attempted.resolve()
      }
    }
    return run(args, options)
  })
  discardRepoPreparations(entry.repoPathKey)
  await queued.promise
  await vi.advanceTimersByTimeAsync(30_000)
  admitted.resolve()
  await attempted.promise
  await create('after-abandoned-discard')
  expect(await readFile(join(entry.preparedPath, 'version.txt'), 'utf8')).toBe('original\n')
  expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain(entry.lockReason)
})
