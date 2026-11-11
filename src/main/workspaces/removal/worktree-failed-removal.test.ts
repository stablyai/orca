// Mock Git for cross-platform coverage; real-Git cases live in runtime/runtime-failed-local-worktree-removal.test.ts.
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import type * as WorktreeRemovalModule from '../../git/worktrees/removal/worktree-removal'
import { deleteBranchOfUnregisteredWorktree } from '../../git/worktrees/removal/worktree-removal'
import { beginTerminalInstall } from './watcher-removal-gate'
import '../../ipc/worktree-logic'
import '../../ipc/worktrees/listing/worktree-change-invalidators'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  retryFailedWorktreeRemoval,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval,
  type BackgroundWorktreeRemovalJob
} from './worktree-background-removal'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from './worktree-removal-listing'
import { readWorktreeRemovalRecords } from './worktree-removal-records'
import { loadWorktreeRemovalRecordsForStore } from '../../startup/worktree-removal-records-load'

const listWorktreesStrictMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))
vi.mock('../../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRemovalModule>()),
  deleteBranchOfUnregisteredWorktree: vi.fn(async () => ({}))
}))

const GIT_ERROR = "error: failed to delete 'node_modules/a/LICENSE': Operation not permitted"
let directory = ''
let checkout = ''
let worktreeId = ''
const mainWorktree: GitWorktreeInfo = {
  path: '/work/repo',
  head: 'abc',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-failed-removal-')))
  checkout = join(directory, 'feature-$&-$$-$`')
  worktreeId = `repo-1::${checkout}`
  // What Git left: part of the checkout, `.git` already deleted.
  await mkdir(join(checkout, 'node_modules', 'a'), { recursive: true })
  await writeFile(join(checkout, 'node_modules', 'a', 'LICENSE'), 'MIT\n')
  await mkdir(join(directory, 'profile'))
  await loadWorktreeRemovalRecords(join(directory, 'profile'))
  vi.mocked(listWorktreesStrict).mockResolvedValue([mainWorktree])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  vi.mocked(deleteBranchOfUnregisteredWorktree).mockReset()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function startFailingRemoval(
  job: Partial<Pick<BackgroundWorktreeRemovalJob, 'run' | 'cleanupPushTargetRemote'>> = {}
): Promise<unknown> {
  return startBackgroundWorktreeRemoval({
    removal: {
      worktreeId,
      repoId: 'repo-1',
      repoPath: '/work/repo',
      worktree: { path: checkout, branch: 'refs/heads/feature', head: 'abc' },
      deleteBranch: true,
      force: true
    },
    run: async () => {
      throw new Error(GIT_ERROR)
    },
    publish: () => {},
    ...job
  })
}

async function failRemoval(): Promise<void> {
  await expect(startFailingRemoval()).rejects.toThrow(GIT_ERROR)
  await _settlePendingWorktreeRemovalsForTests()
}

async function listRows(): Promise<GitWorktreeInfo[]> {
  return withUnregisteredRemovalCheckouts('repo-1', [mainWorktree])
}

const leftoverRow = (): GitWorktreeInfo => ({
  path: checkout,
  head: 'abc',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false,
  removalError: GIT_ERROR
})

describe('a delete that fails after Git dropped the registration', () => {
  it('keeps the leftover listed with the error, recorded on disk, and not pending', async () => {
    await failRemoval()

    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    const [record] = await readWorktreeRemovalRecords(join(directory, 'profile'))
    expect(record).toMatchObject({ worktreeId, failure: { message: GIT_ERROR } })
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBeUndefined()
    const rows: { id: string; hostId?: undefined }[] = [{ id: worktreeId }]
    expect(
      projectPendingWorktreeRemovals(
        rows,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual(rows)
    // Nothing fences the leftover: a failed delete must not block terminals indefinitely.
    beginTerminalInstall(checkout)()
  })

  it.each(['branch', 'head'])(
    'retires a stale registered failure by %s without cleanup',
    async (kind) => {
      const original = { ...leftoverRow(), removalError: undefined }
      vi.mocked(listWorktreesStrict).mockResolvedValue([mainWorktree, original])
      const cleanupPushTargetRemote = vi.fn(async () => {})
      await expect(startFailingRemoval({ cleanupPushTargetRemote })).rejects.toThrow(GIT_ERROR)
      await _settlePendingWorktreeRemovalsForTests()
      expect(await withUnregisteredRemovalCheckouts('repo-1', [original])).toEqual([leftoverRow()])
      const replacement = { ...original, [kind]: kind === 'branch' ? 'refs/heads/other' : 'def' }
      expect(await withUnregisteredRemovalCheckouts('repo-1', [replacement])).toEqual([replacement])
      await vi.waitFor(async () =>
        expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
      )
      expect(deleteBranchOfUnregisteredWorktree).not.toHaveBeenCalled()
      expect(cleanupPushTargetRemote).not.toHaveBeenCalled()
    }
  )

  it('keeps the failed row and its error when that bookkeeping fails', async () => {
    vi.mocked(deleteBranchOfUnregisteredWorktree).mockRejectedValue(new Error('branch locked'))
    const cleanupPushTargetRemote = vi.fn(async () => {
      throw new Error('remote busy')
    })
    await expect(startFailingRemoval({ cleanupPushTargetRemote })).rejects.toThrow(GIT_ERROR)
    await _settlePendingWorktreeRemovalsForTests()

    expect(cleanupPushTargetRemote).toHaveBeenCalledTimes(1)
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toMatchObject([
      { worktreeId, failure: { message: GIT_ERROR } }
    ])
  })

  it('runs the recorded removal again on Delete and clears the record once it succeeds', async () => {
    await failRemoval()
    const publish = vi.fn()
    const run = vi.fn(async () => {
      expect(await listRows()).toEqual([
        mainWorktree,
        { ...leftoverRow(), removalError: undefined }
      ])
      await rm(checkout, { recursive: true })
      return {}
    })

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) => {
      expect(record).toMatchObject({ deleteBranch: true, force: true })
      expect(record).not.toHaveProperty('failure')
      return { run, publish }
    })

    expect(waitForPendingWorktreeRemoval(worktreeId)).toBe(retried)
    await expect(retried).resolves.toEqual({})
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).toHaveBeenCalledTimes(1)
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    expect(await listRows()).toEqual([mainWorktree])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
  })

  it('keeps the row with the new error when the retry fails the same way', async () => {
    await failRemoval()
    const retried = retryFailedWorktreeRemoval(worktreeId, undefined, () => ({
      run: async () => {
        throw new Error('still not permitted')
      },
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow('still not permitted')
    await _settlePendingWorktreeRemovalsForTests()
    expect(await listRows()).toEqual([
      mainWorktree,
      { ...leftoverRow(), removalError: 'still not permitted' }
    ])
  })

  it('does not run the recorded removal once Git registers a checkout at the path again', async () => {
    await failRemoval()
    const [record] = await readWorktreeRemovalRecords(join(directory, 'profile'))
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      mainWorktree,
      { ...leftoverRow(), removalError: undefined }
    ])
    const run = vi.fn(async () => ({}))

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run,
      publish: () => {}
    }))

    const message = `A different checkout is now at ${checkout}; Orca left it in place. Delete it again to remove it.`
    await expect(retried).rejects.toThrow(message)
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([
      { ...record, failure: { message, failedAt: expect.any(Number) } }
    ])
  })

  it('ends at the next listing once the checkout is deleted outside Orca', async () => {
    await failRemoval()
    await rm(checkout, { recursive: true })

    expect(await listRows()).toEqual([mainWorktree])
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('ends at startup once its repo is removed from Orca, leaving the files', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()

    // Only an SSH copy of the project is left under the same repo id.
    await loadWorktreeRemovalRecordsForStore({
      getProfileStorageDirectory: () => join(directory, 'profile'),
      getRepos: () => [{ id: 'repo-1', connectionId: 'box', executionHostId: null }]
    })

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    expect(await readdir(checkout)).toEqual(['node_modules'])
  })

  it('ends at the next listing once a different checkout takes the path', async () => {
    await failRemoval()
    await mkdir(join(checkout, '.git'))

    expect(await listRows()).toEqual([mainWorktree])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })
})
