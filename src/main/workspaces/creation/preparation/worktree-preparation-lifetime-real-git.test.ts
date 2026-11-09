import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import * as wslGate from '../../../wsl/filesystem/wsl-unc-access-gate'
import { preparationCapacityUsed } from './worktree-preparation-discard-retry'
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

it('parks an unproven writer and autonomously removes its hidden checkout after late proof', async () => {
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
  expect(existsSync(join(preparedPath, '.git'))).toBe(true)
  // Repeated requests cannot revive or wait again on the same parked writer.
  await arm()
  await arm()
  terminated.resolve()
  await vi.waitFor(() => expect(existsSync(preparedPath)).toBe(false))
  await create('after-writer')
  expect(await readFile(join(root, 'writer-fallback', 'version.txt'), 'utf8')).toBe('original\n')
  expect(git(root, '-C', join(root, 'repo'), 'worktree', 'list', '--porcelain')).not.toContain(
    preparedPath
  )
})

it('revokes an expired queued remove and admits fresh owned cleanup on its exact wake', async () => {
  const { repoPath, arm, create } = await fixture()
  const queued = Promise.withResolvers<void>()
  const admitted = Promise.withResolvers<void>()
  const attempted = Promise.withResolvers<void>()
  let first = true
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await arm()
  const [entry] = listPreparations()
  const run = gitRunner.gitExecFileAsync
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove') && first) {
      first = false
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
  await vi.waitFor(() => expect(existsSync(entry.preparedPath)).toBe(false))
  await create('after-abandoned-discard')
  expect(git(repoPath, 'worktree', 'list', '--porcelain')).not.toContain(entry.lockReason)
})

it.each([3, 30])(
  'bounds physical preparations under %i requests while cleanup is exhausted',
  async (requests) => {
    const owners = await Promise.all([fixture(), fixture(), fixture()])
    for (const owner of owners) {
      await owner.arm()
    }
    const entries = listPreparations()
    const run = gitRunner.gitExecFileAsync
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args.includes('remove')) {
        throw new Error('checkout temporarily locked')
      }
      return run(args, options)
    })
    for (const entry of entries) {
      discardRepoPreparations(entry.repoPathKey)
    }
    const other = await fixture()
    for (let index = 0; index < requests; index += 1) {
      await other.arm()
    }
    expect(
      entries.filter((entry) => existsSync(join(entry.preparedPath, 'version.txt')))
    ).toHaveLength(3)
    expect(listPreparations()).toHaveLength(0)
    await other.create('normal-create')
    expect(await readFile(join(other.root, 'normal-create', 'version.txt'), 'utf8')).toBe(
      'original\n'
    )
  }
)

it('retries another repository before declining a full-pool request', async () => {
  const owners = await Promise.all([fixture(), fixture(), fixture()])
  for (const owner of owners) {
    await owner.arm()
  }
  const entries = listPreparations()
  const run = gitRunner.gitExecFileAsync
  let fail = true
  const failed = Promise.withResolvers<void>()
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove') && fail) {
      failed.resolve()
      throw new Error('transient checkout lock')
    }
    return run(args, options)
  })
  discardRepoPreparations(entries[0].repoPathKey)
  await failed.promise
  await entries[0].operation.discard()
  fail = false
  const other = await fixture()
  await other.arm()
  expect(existsSync(entries[0].preparedPath)).toBe(false)
  expect(listPreparations().some((entry) => entry.repoPath === other.repoPath)).toBe(true)
})

it.each(['hidden', 'moved', 'unproven-target'])(
  'preserves finalization recovery for %s failure through the create consumer',
  async (kind) => {
    const { root, repoPath, arm, create } = await fixture()
    await arm()
    const [entry] = listPreparations()
    if (kind === 'hidden') {
      await writeFile(join(repoPath, 'version.txt'), 'requested\n')
      git(repoPath, 'commit', '--quiet', '-am', 'new base')
    }
    const target = join(root, 'finalization-recovery')
    const proof = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const originalError = new Error('prepared finalization failed')
    const run = gitRunner.gitExecFileAsync
    let injected = false
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const selected =
        kind === 'hidden'
          ? args.includes('reset')
          : kind === 'moved'
            ? args.includes('checkout')
            : args.includes('move')
      if (selected && !injected) {
        injected = true
        if (kind !== 'moved') {
          options.observeChildTermination?.(proof.promise, true)
        }
        if (kind !== 'hidden') {
          await run(args, options)
        }
        failed.resolve()
        throw originalError
      }
      return run(args, options)
    })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const creating = create('finalization-recovery')
    const outcome =
      kind === 'unproven-target' ? expect(creating).rejects.toBe(originalError) : creating
    await failed.promise
    if (kind !== 'moved') {
      await vi.advanceTimersByTimeAsync(30_000)
    }
    await outcome
    if (kind === 'moved') {
      expect(await readFile(join(target, 'version.txt'), 'utf8')).toBe('original\n')
      expect(git(target, 'branch', '--show-current')).toBe('finalization-recovery')
    } else {
      if (kind === 'unproven-target') {
        expect(git(repoPath, 'branch', '--list', 'finalization-recovery')).toBe('')
      } else {
        expect(await readFile(join(target, 'version.txt'), 'utf8')).toBe('requested\n')
        expect(existsSync(entry.preparedPath)).toBe(true)
      }
      proof.resolve()
      if (kind === 'hidden') {
        await vi.waitFor(() => expect(existsSync(entry.preparedPath)).toBe(false))
      } else {
        await writeFile(join(target, 'user.txt'), 'preserve returned target\n')
        await arm()
        expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('preserve returned target\n')
      }
    }
  }
)

it.each(['missing', 'foreign'])(
  'retains unknown capacity but releases affirmative %s authority',
  async (kind) => {
    const { arm } = await fixture()
    await arm()
    const [entry] = listPreparations()
    const lock = git(entry.preparedPath, 'rev-parse', '--git-path', 'locked')
    await (kind === 'missing' ? rm(lock) : writeFile(lock, 'replacement owner\n'))
    discardRepoPreparations(entry.repoPathKey)
    await entry.operation.discard()
    expect(existsSync(join(entry.preparedPath, 'version.txt'))).toBe(true)
    expect(preparationCapacityUsed()).toBe(kind === 'missing' ? 1 : 0)
  }
)

it('leaves stopped hosts untouched and retries only after the host becomes eligible', async () => {
  const { arm } = await fixture()
  await arm()
  const [entry] = listPreparations()
  const blocked = vi
    .spyOn(wslGate, 'blockedWslDistroForPath')
    .mockResolvedValue({ distro: 'stopped', state: 'stopped' })
  discardRepoPreparations(entry.repoPathKey)
  await entry.operation.discard()
  expect(existsSync(join(entry.preparedPath, 'version.txt'))).toBe(true)
  await arm()
  expect(existsSync(entry.preparedPath)).toBe(true)
  blocked.mockResolvedValue(null)
  await arm()
  expect(existsSync(entry.preparedPath)).toBe(false)
})

it('releases exhausted capacity when the final admitted removal completes late', async () => {
  const { arm } = await fixture()
  await arm()
  const [entry] = listPreparations()
  const run = gitRunner.gitExecFileAsync
  const admitted = Promise.withResolvers<void>()
  const proof = Promise.withResolvers<void>()
  let failures = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove')) {
      if (failures++ < 2) {
        throw new Error('temporary file lock')
      }
      const result = await run(args, options)
      options.observeChildTermination?.(proof.promise, true)
      admitted.resolve()
      return result
    }
    return run(args, options)
  })
  discardRepoPreparations(entry.repoPathKey)
  await entry.operation.discard()
  await entry.operation.discard()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const cleanup = entry.operation.discard()
  await admitted.promise
  await vi.advanceTimersByTimeAsync(30_000)
  await cleanup
  expect(preparationCapacityUsed()).toBe(1)
  proof.resolve()
  await vi.waitFor(() => expect(preparationCapacityUsed()).toBe(0))
})
