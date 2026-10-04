// Real-Git coverage for a delete Git fails partway: `git worktree remove --force` drops the
// registration even when it cannot delete a file, so Orca must keep the leftover listed and
// retryable itself. macOS only: `chflags uchg` is the portable way to make a file undeletable for
// the file's owner; worktree-failed-removal.test.ts covers the same rules with Git mocked.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence'
import type * as HostTreeRemoval from '../host-tree-removal'
import type * as GitFileRestore from '../git/worktree-git-file-restore'
import { restoreMissingWorktreeGitFile } from '../git/worktree-git-file-restore'
import { removeHostTree } from '../host-tree-removal'
import { listWorktreesStrict, removeWorktree } from '../git/worktree'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import {
  _worktreeDeleteLimitSnapshotForTests,
  runUnderWorktreeDeleteLimit
} from '../git/worktree-delete-limit'
import { acquireWatcherRemovalGate, beginTerminalInstall } from '../ipc/watcher-removal-gate'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../worktree-background-removal'
import { withUnregisteredRemovalCheckouts } from '../worktree-removal-listing'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords,
  type WorktreeRemovalRecord
} from '../worktree-removal-records'
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../git/worktree-git-file-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof GitFileRestore>()
  return { ...actual, restoreMissingWorktreeGitFile: vi.fn(actual.restoreMissingWorktreeGitFile) }
})
vi.mock('../host-tree-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof HostTreeRemoval>()
  return { ...actual, removeHostTree: vi.fn(actual.removeHostTree) }
})

const execFileAsync = promisify(execFile)

let scratchDir = ''
let recordsDir = ''
let repoPath = ''
let worktreePath = ''
let lockedFile = ''
let worktreeId = ''
let repo: Repo

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

async function setImmutable(on: boolean, path = lockedFile): Promise<void> {
  await execFileAsync('chflags', on ? ['uchg', path] : ['-R', 'nouchg', path])
}

async function listedRows(): Promise<{ path: string; removalError?: string }[]> {
  return (await withUnregisteredRemovalCheckouts(repo.id, await listWorktreesStrict(repoPath)))
    .filter((row) => !row.isMainWorktree)
    .map(({ path, removalError }) => ({ path, ...(removalError ? { removalError } : {}) }))
}

function jobHost(purged: string[], stopPtys = vi.fn(async () => {})) {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the finish reads only repos and worktree metadata from the store here; git options are mocked and no push target is set.
    store: {
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getRepos: () => [repo],
      getWorktreeMeta: () => undefined
    } as unknown as Store,
    acquireWatcherRemoval: async (path: string) => {
      const gate = acquireWatcherRemovalGate(path)
      return { finish: async () => gate.release() }
    },
    closeWatchers: async () => {},
    stopPtys,
    preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: vi.fn() },
    purge: ({ worktreeId: id }: WorktreeRemovalRecord) => purged.push(id),
    onRemoved: () => {},
    publish: () => {}
  } satisfies Parameters<typeof interruptedLocalWorktreeRemovalJob>[1]
}

/** A delete a quit interrupted, finished at the next start, where Git fails on the locked file. */
function failStartupFinish(): Promise<unknown> {
  return finishAtStartup([])
}

/** Resumes a recorded delete of the checkout as the next start does; resolves with its error. */
async function finishAtStartup(purged: string[]): Promise<unknown> {
  const record: WorktreeRemovalRecord = {
    worktreeId,
    repoId: repo.id,
    repoPath,
    worktreePath,
    branch: 'feature',
    head: (await git(['rev-parse', 'feature'])).trim(),
    deleteBranch: true,
    force: true,
    requestedAt: 1
  }
  await writeWorktreeRemovalRecords(recordsDir, () => [record])
  await loadWorktreeRemovalRecords(recordsDir)
  const joined = waitForPendingWorktreeRemoval(worktreeId)!
  resumeInterruptedWorktreeRemovals((interrupted) =>
    interruptedLocalWorktreeRemovalJob(interrupted, jobHost(purged))
  )
  const error = await joined.then(
    () => undefined,
    (reason: unknown) => reason
  )
  await _settlePendingWorktreeRemovalsForTests()
  return error
}

/** The same delete in session: the job runs Git's `worktree remove --force`, as Delete's does. */
async function failInSession(): Promise<unknown> {
  const error = await startBackgroundWorktreeRemoval({
    removal: {
      worktreeId,
      repoId: repo.id,
      repoPath,
      worktree: { path: worktreePath, branch: 'refs/heads/feature', head: 'abc' },
      deleteBranch: true,
      force: true
    },
    run: () => removeWorktree(repoPath, worktreePath, true),
    publish: () => {}
  }).then(
    () => undefined,
    (reason: unknown) => reason
  )
  await _settlePendingWorktreeRemovalsForTests()
  return error
}

describe.skipIf(process.platform !== 'darwin')('a worktree delete Git fails partway', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-failed-removal-')))
    recordsDir = join(scratchDir, 'profile')
    repoPath = join(scratchDir, 'repo')
    worktreePath = join(scratchDir, 'workspaces', 'feature')
    worktreeId = `repo-1::${worktreePath}`
    await mkdir(recordsDir, { recursive: true })
    await mkdir(repoPath, { recursive: true })
    await git(['init', '-q'])
    await git(['config', 'user.email', 'removal@example.invalid'])
    await git(['config', 'user.name', 'Worktree Removal'])
    await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
    await git(['add', '-A'])
    await git(['commit', '-qm', 'seed'])
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
    lockedFile = join(worktreePath, 'node_modules', 'a', 'LICENSE')
    await mkdir(join(worktreePath, 'node_modules', 'a'), { recursive: true })
    await writeFile(lockedFile, 'MIT\n')
    await setImmutable(true)
    repo = { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
    await loadWorktreeRemovalRecords(recordsDir)
  })

  afterEach(async () => {
    _resetPendingWorktreeRemovalsForTests()
    vi.mocked(removeHostTree).mockClear()
    vi.restoreAllMocks()
    await setImmutable(false, scratchDir)
    expect((await execFileAsync('find', [scratchDir, '-flags', '+uchg'])).stdout).toBe('')
    await removeTree(scratchDir)
  })

  it('keeps the leftover listed with Git’s error after the startup finish fails', async () => {
    const error = await failStartupFinish()

    expect(String(error)).toMatch(/Operation not permitted/)
    // What Git left: no registration, but the checkout, the branch and Orca's record.
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(existsSync(lockedFile)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])
    // The leftover is not fenced: terminals may open in it while it waits for the user.
    beginTerminalInstall(worktreePath)()
  })

  it('keeps the leftover listed with Git’s error after an in-session delete fails', async () => {
    const error = await failInSession()

    expect(String(error)).toMatch(/Operation not permitted/)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])
  })

  it('does not retry it at the next start', async () => {
    await failStartupFinish()
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(recordsDir)
    const jobFor = vi.fn()

    resumeInterruptedWorktreeRemovals(jobFor)

    expect(jobFor).not.toHaveBeenCalled()
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBeUndefined()
    expect(existsSync(lockedFile)).toBe(true)
    expect(await listedRows()).toHaveLength(1)
  })

  it('Delete retries it once the file can be deleted: files, branch, metadata and record go', async () => {
    await failInSession()
    await setImmutable(false)
    const purged: string[] = []
    const stopPtys = vi.fn(async () => {})

    const result = await retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged, stopPtys))
    )
    await _settlePendingWorktreeRemovalsForTests()

    expect(result).toEqual({})
    expect(stopPtys).toHaveBeenCalledTimes(1)
    // Git has no registration left to delete by, so Orca deletes the leftover itself.
    expect(removeHostTree).toHaveBeenCalledWith(worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([worktreeId])
    expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
    expect(await listedRows()).toEqual([])
  })

  it('the record ends once the checkout is deleted outside Orca', async () => {
    await failInSession()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })

    expect(await listedRows()).toEqual([])
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([]))
  })

  it('never deletes a different checkout created at the path since', async () => {
    await failInSession()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    await mkdir(worktreePath)
    await git(['init', '-q'], worktreePath)
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')
    const purged: string[] = []

    // Delete before any listing noticed: the retry refuses and lets the record go.
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged))
    )
    await expect(retried).rejects.toThrow(/A different checkout is now at/)
    await _settlePendingWorktreeRemovalsForTests()

    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
    expect(await listedRows()).toEqual([])
  })

  it('never deletes a worktree Git registers at the path since, even on the same branch', async () => {
    await failStartupFinish()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    await git(['worktree', 'add', '-q', worktreePath, 'feature'])
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')
    const purged: string[] = []

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged))
    )
    await expect(retried).rejects.toThrow(/A different checkout is now at/)
    await _settlePendingWorktreeRemovalsForTests()

    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(purged).toEqual([])
    expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
  })

  it('never deletes a worktree Git registers inside the leftover', async () => {
    await failInSession()
    await setImmutable(false)
    const nested = join(worktreePath, 'sub')
    await git(['worktree', 'add', '-q', nested, '-b', 'nested'])
    await writeFile(join(nested, 'unsaved.txt'), 'work\n')
    const purged: string[] = []

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged))
    )
    await expect(retried).rejects.toThrow(/contains another registered worktree/)
    await _settlePendingWorktreeRemovalsForTests()

    expect(existsSync(join(nested, 'unsaved.txt'))).toBe(true)
    expect(await isRegistered(nested)).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    // The row keeps the refusal, so the user can move the nested worktree and Delete again.
    expect(await listedRows()).toContainEqual({
      path: worktreePath,
      removalError: expect.stringMatching(/contains another registered worktree/)
    })
  })

  it('checks the leftover again inside the delete slot, right before deleting', async () => {
    await failInSession()
    await setImmutable(false)
    // Both delete slots busy, as behind two large deletes.
    let releaseSlots = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseSlots = resolve
    })
    const holders = [
      runUnderWorktreeDeleteLimit(() => held),
      runUnderWorktreeDeleteLimit(() => held)
    ]
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost([]))
    )
    const settled = retried!.then(
      () => undefined,
      (reason: unknown) => reason
    )
    await vi.waitFor(() => expect(_worktreeDeleteLimitSnapshotForTests().waiting).toBe(1))
    // While it waits, the leftover is replaced by a different checkout.
    await rm(worktreePath, { recursive: true })
    await mkdir(worktreePath)
    await git(['init', '-q'], worktreePath)
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')
    releaseSlots()
    await Promise.all(holders)

    expect(String(await settled)).toMatch(/A different checkout is now at/)
    await _settlePendingWorktreeRemovalsForTests()
    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
  })

  it('at startup, still deletes the recorded checkout when its missing .git cannot be restored', async () => {
    await setImmutable(false)
    // Git deleted `.git` first and the link cannot be written back, so Git cannot remove it.
    await rm(join(worktreePath, '.git'))
    vi.mocked(restoreMissingWorktreeGitFile).mockResolvedValueOnce(false)
    const purged: string[] = []

    expect(await finishAtStartup(purged)).toBeUndefined()

    expect(removeHostTree).toHaveBeenCalledWith(worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([worktreeId])
  })
})
