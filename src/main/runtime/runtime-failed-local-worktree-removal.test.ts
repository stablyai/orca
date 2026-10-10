// Real-Git coverage for a delete Git fails partway: `git worktree remove --force` drops the
// registration even when it cannot delete a file, so Orca must keep the leftover listed and
// retryable itself. macOS only: `chflags uchg` is the portable way to make a file undeletable for
// the file's owner; worktree-failed-removal.test.ts covers the same rules with Git mocked.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence'
import type * as HostTreeRemoval from '../host-tree-removal'
import { removeHostTree } from '../host-tree-removal'
import { listWorktreesStrict, removeWorktree } from '../git/worktree'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
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
import { retryFailedRemovalUnlessRegistered } from '../worktree-removal-leftover'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords,
  type WorktreeRemovalRecord
} from '../worktree-removal-records'
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
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

/** Reads only repos and worktree metadata, as the finish and the push-target cleanup do. */
function storeStub(pushTarget?: GitPushTarget) {
  const meta = pushTarget ? { pushTarget } : undefined
  return {
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getRepos: () => [repo],
    getWorktreeMeta: (id: string) => (id === worktreeId ? meta : undefined),
    getAllWorktreeMeta: () => (meta ? { [worktreeId]: meta } : {})
  }
}

/** A remote Orca added for a fork PR's push target, as worktree create does. */
async function addOrcaPushTargetRemote(): Promise<GitPushTarget> {
  const pushTarget = {
    remoteName: 'pr-contributor',
    branchName: 'feature',
    remoteUrl: 'https://github.com/contributor/repo.git',
    remoteCreated: true
  }
  await git(['remote', 'add', pushTarget.remoteName, pushTarget.remoteUrl])
  await git(['config', `remote.${pushTarget.remoteName}.orca-created`, 'true'])
  return pushTarget
}

function jobHost(purged: string[], stopPtys = vi.fn(async () => {}), pushTarget?: GitPushTarget) {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the finish reads only repos and worktree metadata from the store here; git options are mocked.
    store: storeStub(pushTarget) as unknown as Store,
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

/** Delete on the row, as desktop and runtime run it: Git's listing first, then the retry. */
async function deleteRow(purged: string[], stopPtys = vi.fn(async () => {})): Promise<unknown> {
  const listed = await listWorktreesStrict(repoPath)
  const retried = await retryFailedRemovalUnlessRegistered(worktreeId, worktreePath, listed, () =>
    retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged, stopPtys))
    )
  ).catch((reason: unknown) => reason)
  if (retried !== true) {
    return retried
  }
  const error = await waitForPendingWorktreeRemoval(worktreeId)?.then(
    () => undefined,
    (reason: unknown) => reason
  )
  await _settlePendingWorktreeRemovalsForTests()
  return error
}

const refusal = (): string =>
  `Git no longer tracks ${worktreePath}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`

/** A delete a quit interrupted, finished at the next start, where Git fails on the locked file. */
function failStartupFinish(): Promise<unknown> {
  return finishAtStartup([])
}

/** Resumes a recorded delete of the checkout as the next start does; resolves with its error. */
async function finishAtStartup(purged: string[], pushTarget?: GitPushTarget): Promise<unknown> {
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
    interruptedLocalWorktreeRemovalJob(interrupted, jobHost(purged, undefined, pushTarget))
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
    // What Git left: no registration, but the checkout and Orca's record. The merged branch went
    // with the failed delete, as its finish would have deleted it.
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(existsSync(lockedFile)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
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

  it('Delete refuses while the leftover is there, and finishes metadata and record once the user removed it', async () => {
    await failInSession()
    await setImmutable(false)
    const purged: string[] = []
    const stopPtys = vi.fn(async () => {})

    expect(String(await deleteRow(purged, stopPtys))).toBe(`Error: ${refusal()}`)
    expect(existsSync(lockedFile)).toBe(true)
    expect(stopPtys).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])

    await rm(worktreePath, { recursive: true })
    expect(await deleteRow(purged, stopPtys)).toBeUndefined()

    expect(stopPtys).toHaveBeenCalledTimes(1)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([worktreeId])
    expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
    expect(await listedRows()).toEqual([])
  })

  it('Delete deletes nothing in an ordinary folder the user put in place of the leftover', async () => {
    await failInSession()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    await mkdir(worktreePath)
    await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')
    const purged: string[] = []

    expect(String(await deleteRow(purged))).toBe(`Error: ${refusal()}`)

    expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])
    expect(await readWorktreeRemovalRecords(recordsDir)).toMatchObject([
      { worktreeId, failure: { message: expect.stringMatching(/Operation not permitted/) } }
    ])
  })

  it('deletes the merged branch when the delete fails, and only the folder is left to the user', async () => {
    await failInSession()

    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(existsSync(lockedFile)).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])

    // The listing ends the record once the folder is gone; nothing of the delete is left owed.
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    expect(await listedRows()).toEqual([])
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([]))
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
  })

  it('leaves another worktree registered while its folder is missing, as on an unmounted drive', async () => {
    const parent = join(scratchDir, 'volume')
    const other = join(parent, 'other')
    await git(['worktree', 'add', '-q', other, '-b', 'other'])
    await writeFile(join(other, 'wip.txt'), 'wip\n')
    await rename(parent, join(scratchDir, 'volume-unmounted'))

    expect(String(await failInSession())).toMatch(/Operation not permitted/)

    expect(await isRegistered(other)).toBe(true)
    await rename(join(scratchDir, 'volume-unmounted'), parent)
    expect(await git(['status', '--porcelain'], other)).toBe('?? wip.txt\n')
  })

  it('removes the push-target remote Orca added when a runtime delete fails', async () => {
    const pushTarget = await addOrcaPushTargetRemote()
    const worktree = (await listWorktreesStrict(repoPath)).find((row) =>
      areWorktreePathsEqual(row.path, worktreePath)
    )!
    const accepted = await removeRuntimeRegisteredLocalWorktree({
      repo,
      target: { id: worktreeId, repoId: repo.id, path: worktreePath, pushTarget },
      registeredWorktree: worktree,
      removedPushTarget: pushTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delete reads only repos and worktree metadata from the store here.
      store: storeStub(pushTarget) as unknown as RuntimeStore,
      localOptions: {},
      hasLocalOptions: false,
      force: true,
      runHooks: false,
      allowFailedArchiveHook: false,
      allowUnverifiedPtyStop: false,
      deleteBranch: true,
      acquireWatcherRemoval: async (path) => {
        const gate = acquireWatcherRemovalGate(path)
        return { finish: async () => gate.release() }
      },
      stopPtys: async () => {},
      closeWatchers: async () => {},
      preserveBranchHead: (result) => result ?? {},
      finishRemoval: () => {},
      onRemoved: () => {},
      publish: () => {}
    })
    expect(accepted).toMatchObject({ removing: true })
    const error = await waitForPendingWorktreeRemoval(worktreeId)?.catch(
      (reason: unknown) => reason
    )
    await _settlePendingWorktreeRemovalsForTests()

    expect(String(error)).toMatch(/Operation not permitted/)
    expect(await git(['remote'])).not.toContain(pushTarget.remoteName)
    expect(existsSync(lockedFile)).toBe(true)
  })

  it('removes the push-target remote Orca added when the startup finish fails', async () => {
    const pushTarget = await addOrcaPushTargetRemote()

    expect(String(await finishAtStartup([], pushTarget))).toMatch(/Operation not permitted/)

    expect(await git(['remote'])).not.toContain(pushTarget.remoteName)
    expect(existsSync(lockedFile)).toBe(true)
  })

  it('keeps an unmerged branch when the delete fails, as a normal delete does', async () => {
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', 'work.txt'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    const head = (await git(['rev-parse', 'feature'])).trim()

    expect(String(await failInSession())).toMatch(/Operation not permitted/)

    expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
    expect(existsSync(lockedFile)).toBe(true)
    expect(await listedRows()).toEqual([
      { path: worktreePath, removalError: expect.stringMatching(/Operation not permitted/) }
    ])
  })

  it('never deletes a different checkout created at the path since', async () => {
    await failInSession()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    await mkdir(worktreePath)
    await git(['init', '-q'], worktreePath)
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')
    const purged: string[] = []

    // A retry already past Delete's check: the job refuses and lets the record go.
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) =>
      interruptedLocalWorktreeRemovalJob(record, jobHost(purged))
    )
    await expect(retried).rejects.toThrow(refusal())
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
    // The failed delete already deleted the merged branch; the user makes it again.
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
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
    // Named first: removing the folder, as the usual refusal asks, would delete it too.
    const nestedRefusal = `Refusing to delete worktree because it contains another registered worktree: ${nested}`
    await expect(retried).rejects.toThrow(nestedRefusal)
    await _settlePendingWorktreeRemovalsForTests()

    expect(existsSync(join(nested, 'unsaved.txt'))).toBe(true)
    expect(await isRegistered(nested)).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    expect(await listedRows()).toContainEqual({ path: worktreePath, removalError: nestedRefusal })
    // Delete's own check names it as well, before any job runs.
    expect(String(await deleteRow(purged))).toBe(`Error: ${nestedRefusal}`)
    expect(existsSync(join(nested, 'unsaved.txt'))).toBe(true)
  })

  it('checks again after the teardown that the folder is still gone', async () => {
    await failInSession()
    await setImmutable(false)
    await rm(worktreePath, { recursive: true })
    const purged: string[] = []
    // A folder appears at the path while the retry stops terminals.
    const stopPtys = vi.fn(async () => {
      await mkdir(worktreePath)
      await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')
    })

    expect(String(await deleteRow(purged, stopPtys))).toBe(`Error: ${refusal()}`)

    expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
  })

  it('at startup, unregisters a checkout whose .git is gone, keeping its files, until the user removes it', async () => {
    await setImmutable(false)
    await rm(join(worktreePath, '.git'))
    const purged: string[] = []

    expect(String(await finishAtStartup(purged))).toBe(`Error: ${refusal()}`)

    expect(existsSync(join(worktreePath, '.git'))).toBe(false)
    expect(existsSync(lockedFile)).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([])
    expect(await listedRows()).toEqual([{ path: worktreePath, removalError: refusal() }])

    expect(String(await deleteRow(purged))).toBe(`Error: ${refusal()}`)
    expect(existsSync(lockedFile)).toBe(true)

    await rm(worktreePath, { recursive: true })
    expect(await deleteRow(purged)).toBeUndefined()
    expect(purged).toEqual([worktreeId])
    expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
    expect(await listedRows()).toEqual([])
  })
})
