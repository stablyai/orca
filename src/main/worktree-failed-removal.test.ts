// A delete that fails after Git dropped the checkout's registration: the leftover stays listed with
// the error until the checkout disappears, Git registers a checkout there again, or its repo leaves
// Orca; Delete refuses while the folder is on disk. Git is mocked
// here so this runs on every platform; the real-Git version is in
// runtime/runtime-failed-local-worktree-removal.test.ts.
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import type * as WorktreeRemovalModule from './git/worktree-removal'
import { deleteBranchOfUnregisteredWorktree } from './git/worktree-removal'
import { beginTerminalInstall } from './ipc/watcher-removal-gate'
import { registerWorktreeChangeInvalidator } from './ipc/worktree-change-invalidators'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
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
import { retryFailedRemovalUnlessRegistered } from './worktree-removal-leftover'
import { readWorktreeRemovalRecords } from './worktree-removal-records'
import { loadWorktreeRemovalRecordsForStore } from './startup/worktree-removal-records-load'

vi.mock('./git/worktree', () => ({ listWorktreesStrict: vi.fn(async () => []) }))
vi.mock('./git/worktree-removal', async (importOriginal) => ({
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
  checkout = join(directory, 'feature')
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
  job: Pick<BackgroundWorktreeRemovalJob, 'cleanupPushTargetRemote'> = {}
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
    // Not marked removing and not left out for older clients: it is a row they can delete again.
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

  it('invalidates cached listings, which still hold the registration Git dropped', async () => {
    const invalidated = vi.fn()
    const unregister = registerWorktreeChangeInvalidator(invalidated)
    await failRemoval()
    unregister()

    expect(invalidated).toHaveBeenCalledWith('repo-1')
  })

  it('clears the record as before when Git still registers the checkout', async () => {
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      mainWorktree,
      { ...leftoverRow(), removalError: undefined }
    ])
    const cleanupPushTargetRemote = vi.fn(async () => {})
    await expect(startFailingRemoval({ cleanupPushTargetRemote })).rejects.toThrow(GIT_ERROR)
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    // Git still has the checkout, so its branch and remote stay with it.
    expect(deleteBranchOfUnregisteredWorktree).not.toHaveBeenCalled()
    expect(cleanupPushTargetRemote).not.toHaveBeenCalled()
  })

  it('runs the Git side of the delete when it fails: the recorded branch and the push-target remote', async () => {
    const cleanupPushTargetRemote = vi.fn(async () => {})
    await expect(startFailingRemoval({ cleanupPushTargetRemote })).rejects.toThrow(GIT_ERROR)
    await _settlePendingWorktreeRemovalsForTests()

    expect(deleteBranchOfUnregisteredWorktree).toHaveBeenCalledWith('/work/repo', checkout, {
      name: 'feature',
      head: 'abc'
    })
    expect(cleanupPushTargetRemote).toHaveBeenCalledTimes(1)
    expect(await readdir(checkout)).toEqual(['node_modules'])
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
  })

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

  it('clears the record as before when the checkout is gone', async () => {
    await rm(checkout, { recursive: true })
    await failRemoval()

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
  })

  it('never retries it on its own, at startup or when interrupted removals resume', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(join(directory, 'profile'))
    const jobFor = vi.fn()

    resumeInterruptedWorktreeRemovals(jobFor)

    expect(jobFor).not.toHaveBeenCalled()
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBeUndefined()
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    beginTerminalInstall(checkout)()
  })

  it('runs the recorded removal again on Delete and clears the record once it succeeds', async () => {
    await failRemoval()
    const publish = vi.fn()
    const run = vi.fn(async () => {
      // The retry shows as removing while it runs.
      expect(await listRows()).toEqual([
        mainWorktree,
        { ...leftoverRow(), removalError: undefined }
      ])
      await rm(checkout, { recursive: true })
      return {}
    })

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) => {
      // The user's first choices, without the failure.
      expect(record).toMatchObject({ deleteBranch: true, force: true })
      expect(record).not.toHaveProperty('failure')
      return { run, publish }
    })

    // A second window's Delete joins the same run.
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
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      mainWorktree,
      { ...leftoverRow(), removalError: undefined }
    ])
    const run = vi.fn(async () => ({}))

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run,
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow(/A different checkout is now at/)
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
  })

  it('is not retried for another host', async () => {
    await failRemoval()

    expect(retryFailedWorktreeRemoval(worktreeId, 'ssh:box', vi.fn())).toBeUndefined()
  })

  it('ends at the next listing once the checkout is deleted outside Orca', async () => {
    await failRemoval()
    await rm(checkout, { recursive: true })

    expect(await listRows()).toEqual([mainWorktree])
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('ends at startup once the checkout is deleted outside Orca', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()
    await rm(checkout, { recursive: true })

    await loadWorktreeRemovalRecords(join(directory, 'profile'))

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
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

  it('is kept at startup while the repo’s local copy is still in Orca', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()

    await loadWorktreeRemovalRecordsForStore({
      getProfileStorageDirectory: () => join(directory, 'profile'),
      getRepos: () => [
        { id: 'repo-1', connectionId: 'box', executionHostId: null },
        { id: 'repo-1', connectionId: null, executionHostId: null }
      ]
    })

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
    expect(await listRows()).toHaveLength(2)
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

  it('Delete refuses while the folder is on disk: nothing runs, the record and row stay', async () => {
    await failRemoval()
    const retry = vi.fn()

    await expect(
      retryFailedRemovalUnlessRegistered(worktreeId, checkout, [mainWorktree], retry)
    ).rejects.toThrow(
      `Git no longer tracks ${checkout}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`
    )

    expect(retry).not.toHaveBeenCalled()
    expect(await readdir(checkout)).toEqual(['node_modules'])
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
  })

  it('Delete names a worktree Git registers inside the folder, which removing it would delete', async () => {
    await failRemoval()
    const nested = { ...mainWorktree, path: join(checkout, 'sub'), isMainWorktree: false }
    const retry = vi.fn()

    await expect(
      retryFailedRemovalUnlessRegistered(worktreeId, checkout, [mainWorktree, nested], retry)
    ).rejects.toThrow(
      `Refusing to delete worktree because it contains another registered worktree: ${nested.path}`
    )

    expect(retry).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
  })

  it('Delete finishes the recorded removal once the user removed the folder', async () => {
    await failRemoval()
    await rm(checkout, { recursive: true })
    const retry = vi.fn(() => Promise.resolve({}))

    await expect(
      retryFailedRemovalUnlessRegistered(worktreeId, checkout, [mainWorktree], retry)
    ).resolves.toBe(true)

    expect(retry).toHaveBeenCalledTimes(1)
  })
})
