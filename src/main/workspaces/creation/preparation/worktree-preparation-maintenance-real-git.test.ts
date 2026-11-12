import type * as FilePromises from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as gitRunner from '../../../git/command-runner/git-exec-file'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import { preparationCapacityUsed } from './worktree-preparation-discard-retry'
import { _resetWorktreeCreatePreparationsForTests } from './worktree-create-preparation'
import { discardRepoPreparations, listPreparations } from './worktree-create-preparation-pool'
import { fixture, git, removeLifetimeFixtures } from './worktree-preparation-lifetime.test-fixture'
import {
  _resetLocalRepoRefMaintenanceForTests,
  createLocalRepoRefMaintenanceTarget,
  getLocalRepoRefMaintenance
} from '../../../git/refs/maintenance/local-repo-ref-maintenance'

const identityRead = vi.hoisted(
  (): { path?: string; started?: () => void; resume?: Promise<void> } => ({})
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FilePromises>()
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (String(args[0]) === identityRead.path) {
        identityRead.path = undefined
        identityRead.started?.()
        await identityRead.resume
      }
      return actual.realpath(...args)
    }
  }
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  identityRead.path = undefined
  identityRead.started = undefined
  identityRead.resume = undefined
  await _resetWorktreeCreatePreparationsForTests()
  _resetLocalRepoRefMaintenanceForTests()
  await removeLifetimeFixtures()
})

async function attemptMaintenance(repoPath: string): Promise<void> {
  const maintenance = getLocalRepoRefMaintenance()
  maintenance.arm(createLocalRepoRefMaintenanceTarget({ key: repoPath, repoPath }))
  await vi.advanceTimersByTimeAsync(1000)
  await maintenance.whenAttemptSettled()
}

function enableMaintenance(): void {
  _resetLocalRepoRefMaintenanceForTests({
    isBusy: () => false,
    quietPeriodMs: 1000,
    looseRefThreshold: 1
  })
}

it('retires a parked identity-read lease, then removes only through its fresh native-settlement wake', async () => {
  const { repoPath, arm, create } = await fixture()
  const other = await fixture()
  await arm()
  const [entry] = listPreparations()
  const lock = git(entry.preparedPath, 'rev-parse', '--git-path', 'locked')
  const readStarted = Promise.withResolvers<void>()
  const readReleased = Promise.withResolvers<void>()
  identityRead.path = dirname(toHostFilesystemPath(lock))
  identityRead.started = readStarted.resolve
  identityRead.resume = readReleased.promise
  const run = gitRunner.gitExecFileAsync
  const removalPermissions: boolean[] = []
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation((args, options) => {
    if (args.includes('remove')) {
      removalPermissions.push(options.canStart?.() !== false)
    }
    return run(args, options)
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  enableMaintenance()
  discardRepoPreparations(entry.repoPathKey)
  await readStarted.promise
  const disposal = entry.operation.discard()
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    await disposal
    expect(preparationCapacityUsed()).toBe(1)
    expect(existsSync(entry.preparedPath)).toBe(true)
    await attemptMaintenance(other.repoPath)
    expect(existsSync(join(other.repoPath, '.git', 'packed-refs'))).toBe(true)
    await arm()
    await arm()
    expect(removalPermissions).toEqual([])
    readReleased.resolve()
    await vi.waitFor(() => {
      expect(existsSync(entry.preparedPath)).toBe(false)
      expect(preparationCapacityUsed()).toBe(1)
    })
    expect(removalPermissions).toEqual([true])
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).not.toContain(entry.lockReason)
    await create('after-read-lease')
    expect(git(repoPath, 'show', 'after-read-lease:version.txt')).toBe('original')
  } finally {
    readReleased.resolve()
  }
})
