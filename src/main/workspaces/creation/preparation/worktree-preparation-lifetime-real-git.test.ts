import { fixture, git, removeLifetimeFixtures } from './worktree-preparation-lifetime.test-fixture'
import type * as FilePromises from 'node:fs/promises'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import * as gitReadCache from '../../../git/source-control/git-read-cache-invalidation'
import * as gitAdmin from '../../../../shared/git/metadata/git-common-directory'
import { preparationPathKey } from './worktree-create-preparation-claim'
import * as staleCleanup from './worktree-create-preparation-stale-cleanup'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as wslGate from '../../../wsl/filesystem/wsl-unc-access-gate'
import { preparationCapacityUsed } from './worktree-preparation-discard-retry'
import * as gitRunner from '../../../git/command-runner/git-exec-file'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { _resetWorktreeCreatePreparationsForTests } from './worktree-create-preparation'
import {
  discardRepoPreparations,
  listPreparations,
  startPreparation
} from './worktree-create-preparation-pool'

const rootMkdirFailure = vi.hoisted((): { path?: string } => ({}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FilePromises>()
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === rootMkdirFailure.path) {
        return Promise.reject(
          Object.assign(new Error('read-only workspace root'), { code: 'EACCES' })
        )
      }
      return actual.mkdir(...args)
    }
  }
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rootMkdirFailure.path = undefined
  vi.unstubAllEnvs()
  await _resetWorktreeCreatePreparationsForTests()
  await removeLifetimeFixtures()
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

it.each(['missing', 'foreign', 'unregistered'])(
  'retains unknown capacity but releases affirmative %s authority',
  async (kind) => {
    const { arm } = await fixture()
    await arm()
    const [entry] = listPreparations()
    const lock = git(entry.preparedPath, 'rev-parse', '--git-path', 'locked')
    await (kind === 'foreign'
      ? writeFile(lock, 'replacement owner\n')
      : rm(kind === 'unregistered' ? dirname(lock) : lock, { recursive: true }))
    discardRepoPreparations(entry.repoPathKey)
    await entry.operation.discard()
    expect(existsSync(join(entry.preparedPath, 'version.txt'))).toBe(true)
    expect(preparationCapacityUsed()).toBe(kind === 'foreign' ? 0 : 1)
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
  await vi.waitFor(() => expect(existsSync(entry.preparedPath)).toBe(false))
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

it('coalesces healthy fourth-key admission until eviction is proven, then consumes its requested tip', async () => {
  const owners = await Promise.all([fixture(), fixture(), fixture()])
  for (const owner of owners) {
    await owner.arm()
  }
  const entries = listPreparations()
  const fourth = await fixture()
  const removing = Promise.withResolvers<void>()
  const proof = Promise.withResolvers<void>()
  const obsoleteFetch = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation((args, options) => {
    if (args.includes('remove') && options.cwd === owners[0].repoPath) {
      removing.resolve()
      return run(args, {
        ...options,
        observeChildTermination: (terminated, writes) =>
          options.observeChildTermination?.(
            writes ? Promise.all([terminated, proof.promise]).then(() => {}) : terminated,
            writes
          )
      })
    }
    return run(args, options)
  })
  const first = startPreparation(
    {
      repoPath: fourth.repoPath,
      workspaceRoot: fourth.root,
      baseBranch: 'main',
      canonicalBase: 'refs/heads/main',
      options: {},
      beforeMaterialization: obsoleteFetch.promise
    },
    'automatic'
  )
  try {
    await removing.promise
    const joined = fourth.arm(Promise.resolve())
    expect(preparationCapacityUsed()).toBe(3)
    expect(listPreparations().map((entry) => entry.preparedPath)).toEqual(
      entries.slice(1).map((entry) => entry.preparedPath)
    )
    proof.resolve()
    await Promise.all([first, joined])
    expect(listPreparations()).toHaveLength(3)
    const timing = createWorktreeCreateTimingRecorder()
    await fourth.create('fourth-hit', 'main', {}, undefined, timing)
    expect(timing.finish().preparedCheckout).toMatchObject({ status: 'hit', origin: 'prefetch' })
    expect(git(join(fourth.root, 'fourth-hit'), 'branch', '--show-current')).toBe('fourth-hit')
    expect(await readFile(join(fourth.root, 'fourth-hit', 'version.txt'), 'utf8')).toBe(
      'original\n'
    )
  } finally {
    proof.resolve()
    obsoleteFetch.resolve()
    await first.catch(() => {})
  }
})

it('admits with free capacity and reuses an exact full-pool hit while matching cleanup is pending', async () => {
  const owner = await fixture()
  git(owner.repoPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await owner.arm()
  const [retired] = listPreparations()
  const failed = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const third = Promise.withResolvers<void>()
  const releaseThird = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  let attempt = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove') && options.cwd === owner.repoPath) {
      attempt += 1
      if (attempt === 1) {
        failed.resolve()
        throw new Error('transient checkout lock')
      }
      if (attempt === 2) {
        second.resolve()
        await releaseSecond.promise
        throw new Error('still locked')
      }
      third.resolve()
      await releaseThird.promise
    }
    return run(args, options)
  })
  try {
    discardRepoPreparations(retired.repoPathKey)
    await failed.promise
    await retired.operation.discard()
    const free = owner.arm(undefined, {}, 'origin/main')
    await second.promise
    await free
    const other = await fixture()
    await other.arm()
    expect(preparationCapacityUsed()).toBe(3)
    releaseSecond.resolve()
    await retired.operation.discard()
    const exact = owner.arm(undefined, {}, 'origin/main')
    await third.promise
    await exact
    const timing = createWorktreeCreateTimingRecorder()
    await owner.create('retry-isolated', 'origin/main', {}, undefined, timing)
    expect(timing.finish().preparedCheckout?.status).toBe('hit')
    expect(await readFile(join(owner.root, 'retry-isolated', 'version.txt'), 'utf8')).toBe(
      'original\n'
    )
  } finally {
    releaseSecond.resolve()
    releaseThird.resolve()
  }
})

it.each(['removed', 'canceled'])(
  'does not publish an admission invalidated while %s',
  async (kind) => {
    const owners = await Promise.all([fixture(), fixture(), fixture()])
    for (const owner of owners) {
      await owner.arm()
    }
    const fourth = await fixture()
    const removing = Promise.withResolvers<void>()
    const proof = Promise.withResolvers<void>()
    const run = gitRunner.gitExecFileAsync
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation((args, options) => {
      if (args.includes('remove') && options.cwd === owners[0].repoPath) {
        removing.resolve()
        return run(args, {
          ...options,
          observeChildTermination: (terminated, writes) =>
            options.observeChildTermination?.(
              writes ? Promise.all([terminated, proof.promise]).then(() => {}) : terminated,
              writes
            )
        })
      }
      return run(args, options)
    })
    const controller = new AbortController()
    const pending = fourth.arm(undefined, { signal: controller.signal })
    try {
      await removing.promise
      if (kind === 'removed') {
        discardRepoPreparations(preparationPathKey(fourth.repoPath))
      } else {
        controller.abort()
      }
      await pending
      await fourth.create('foreground-during-cleanup')
      expect(
        await readFile(join(fourth.root, 'foreground-during-cleanup', 'version.txt'), 'utf8')
      ).toBe('original\n')
      proof.resolve()
      await owners[0].arm()
      expect(listPreparations().some((entry) => entry.repoPath === fourth.repoPath)).toBe(false)
    } finally {
      proof.resolve()
      controller.abort()
      await pending.catch(() => {})
    }
  }
)

it('bounds distinct capacity waiters while allowing three requests to recover', async () => {
  const owners = await Promise.all([fixture(), fixture(), fixture()])
  for (const owner of owners) {
    await owner.arm()
  }
  const request = await fixture()
  const proof = Promise.withResolvers<void>()
  const removing = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation((args, options) => {
    if (args.includes('remove')) {
      removing.resolve()
      return run(args, {
        ...options,
        observeChildTermination: (terminated, writes) =>
          options.observeChildTermination?.(
            writes ? Promise.all([terminated, proof.promise]).then(() => {}) : terminated,
            writes
          )
      })
    }
    return run(args, options)
  })
  const roots = Array.from({ length: 30 }, (_, index) => join(request.root, `request-${index}`))
  const pending = roots.map((workspaceRoot) =>
    startPreparation({
      repoPath: request.repoPath,
      workspaceRoot,
      baseBranch: 'main',
      canonicalBase: 'refs/heads/main',
      options: {}
    })
  )
  try {
    await removing.promise
    await Promise.all(pending.slice(3))
    expect(preparationCapacityUsed()).toBe(3)
    expect(roots.slice(3).some((root) => existsSync(root))).toBe(false)
    proof.resolve()
    await Promise.all(pending)
    expect(preparationCapacityUsed()).toBe(3)
    expect(
      listPreparations()
        .map((entry) => entry.workspaceRoot)
        .sort()
    ).toEqual(roots.slice(0, 3).sort())
    expect(roots.slice(3).some((root) => existsSync(root))).toBe(false)
  } finally {
    proof.resolve()
    await Promise.allSettled(pending)
  }
})

it('declines after a competing request takes the freed slot without evicting another victim', async () => {
  const owners = await Promise.all([fixture(), fixture(), fixture()])
  for (const owner of owners) {
    await owner.arm()
  }
  const entries = listPreparations()
  const fourth = await fixture()
  const competitor = await fixture()
  const validating = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let checks = 0
  const gate = wslGate.blockedWslDistroForPath
  vi.spyOn(wslGate, 'blockedWslDistroForPath').mockImplementation(async (path, distro, options) => {
    if (path === fourth.repoPath && ++checks === 2) {
      validating.resolve()
      await release.promise
    }
    return gate(path, distro, options)
  })
  const pending = fourth.arm()
  try {
    await validating.promise
    await competitor.arm()
    release.resolve()
    await pending
    expect(preparationCapacityUsed()).toBe(3)
    expect(entries.slice(1).every((entry) => existsSync(entry.preparedPath))).toBe(true)
    expect(listPreparations().some((entry) => entry.repoPath === fourth.repoPath)).toBe(false)
    await fourth.create('competing-fallback')
    expect(await readFile(join(fourth.root, 'competing-fallback', 'version.txt'), 'utf8')).toBe(
      'original\n'
    )
  } finally {
    release.resolve()
    await pending.catch(() => {})
  }
})

it.each([750, 7500])(
  'avoids cleanup reconciliation of %i unrelated registrations when no add was issued',
  async (width) => {
    const owner = await fixture()
    await owner.arm()
    const [primer] = listPreparations()
    discardRepoPreparations(primer.repoPathKey)
    await primer.operation.discard()
    const adminRoot = join(owner.repoPath, '.git', 'worktrees')
    const head = git(owner.repoPath, 'rev-parse', 'HEAD')
    for (let index = 0; index < width; index += 1) {
      const admin = join(adminRoot, `unrelated-${index}`)
      await mkdir(admin, { recursive: true })
      await writeFile(join(admin, 'gitdir'), `${join(owner.root, `unrelated-${index}`, '.git')}\n`)
      await writeFile(join(admin, 'commondir'), '../..\n')
      await writeFile(join(admin, 'HEAD'), `${head}\n`)
    }
    const blockedRoot = join(owner.root, 'read-only-root')
    rootMkdirFailure.path = toHostFilesystemPath(join(blockedRoot, '.orca-preparing'))
    const read = gitAdmin.readGitAdminFile
    let unrelatedReads = 0
    vi.spyOn(gitAdmin, 'readGitAdminFile').mockImplementation((path, signal) => {
      if (path.startsWith(join(adminRoot, 'unrelated-')) && path.endsWith('gitdir')) {
        unrelatedReads += 1
      }
      return read(path, signal)
    })
    const invalidations = vi.spyOn(gitReadCache, 'runWithGitReadCacheInvalidation')
    const lookups = vi.spyOn(gitRunner, 'gitExecFileAsync')
    const staleScan = vi.spyOn(staleCleanup, 'startStalePreparationCleanup').mockResolvedValue()
    for (let request = 0; request < 3; request += 1) {
      await expect(
        startPreparation({
          repoPath: owner.repoPath,
          workspaceRoot: blockedRoot,
          baseBranch: 'main',
          canonicalBase: 'refs/heads/main',
          options: {}
        })
      ).rejects.toMatchObject({ code: 'EACCES' })
      await vi.waitFor(() => expect(preparationCapacityUsed()).toBe(0))
    }
    expect(unrelatedReads).toBe(0)
    expect(invalidations).not.toHaveBeenCalled()
    expect(lookups).not.toHaveBeenCalled()
    lookups.mockRestore()
    staleScan.mockRestore()
    const run = gitRunner.gitExecFileAsync
    let issuedOperation: typeof primer.operation | undefined
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const result = await run(args, options)
      if (args.includes('add') && args.includes('--no-checkout')) {
        issuedOperation = listPreparations()[0].operation
        await rm(args.at(-2)!, { recursive: true, force: true })
        throw new Error('issued add lost its public result')
      }
      return result
    })
    await expect(owner.arm()).rejects.toThrow('issued add lost its public result')
    expect(issuedOperation).toBeDefined()
    await issuedOperation!.discard()
    expect(preparationCapacityUsed()).toBe(0)
    expect(unrelatedReads).toBe(width)
  }
)
