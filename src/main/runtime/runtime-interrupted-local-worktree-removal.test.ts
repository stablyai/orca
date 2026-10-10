// Real-binary coverage for finishing a removal a quit or crash interrupted: what is left has to
// come from Git and disk, whatever point the earlier run reached.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Store } from '../persistence'
import type * as HostTreeRemoval from '../host-tree-removal'
import { removeHostTree } from '../host-tree-removal'
import { listWorktreesStrict } from '../git/worktree'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import {
  acquireWatcherRemovalGate,
  beginTerminalInstall,
  beginWatcherInstall
} from '../ipc/watcher-removal-gate'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
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
vi.mock('../host-tree-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof HostTreeRemoval>()
  return { ...actual, removeHostTree: vi.fn(actual.removeHostTree) }
})

const execFileAsync = promisify(execFile)

let scratchDir = ''
let recordsDir = ''
let repoPath = ''
let worktreePath = ''
let repo: Repo

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Why parsed: Git prints forward slashes on Windows, so raw text never contains a joined path.
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/....
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-interrupted-removal-')))
  recordsDir = join(scratchDir, 'profile')
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'workspaces', 'feature')
  await mkdir(recordsDir, { recursive: true })
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'removal@example.invalid'])
  await git(['config', 'user.name', 'Worktree Removal'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'seed'])
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
  repo = { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
})

afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  vi.mocked(removeHostTree).mockClear()
  await removeTree(scratchDir)
})

type FinishOutcome =
  | ({ status: 'removed' } & RemoveWorktreeResult)
  | { status: 'failed'; error: string }

async function finishAfterRestart(
  options: { repoGone?: boolean; head?: string; force?: boolean } = {}
): Promise<{
  outcome: FinishOutcome
  purged: string[]
  remember: ReturnType<typeof vi.fn>
  records: WorktreeRemovalRecord[]
}> {
  const record: WorktreeRemovalRecord = {
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repoPath,
    worktreePath,
    branch: 'feature',
    head: options.head ?? (await git(['rev-parse', 'feature'])).trim(),
    deleteBranch: true,
    force: options.force ?? false,
    requestedAt: 1
  }
  await writeWorktreeRemovalRecords(recordsDir, () => [record])
  await loadWorktreeRemovalRecords(recordsDir)
  // A request that joins before the finish starts gets the finish's result.
  const joined = waitForPendingWorktreeRemoval(record.worktreeId)
  expect(joined).toBeDefined()
  // Session restore runs before the resume: nothing may open a handle in the half-deleted checkout.
  expect(() => beginTerminalInstall(worktreePath)).toThrow(/being removed/)
  expect(() => beginWatcherInstall(worktreePath)).toThrow(/being removed/)

  const storeStub = {
    getRepo: (id: string) => (id === repo.id && !options.repoGone ? repo : undefined),
    getRepos: () => (options.repoGone ? [] : [repo]),
    getWorktreeMeta: () => undefined
  }
  const purged: string[] = []
  const remember = vi.fn()
  resumeInterruptedWorktreeRemovals((interrupted) =>
    interruptedLocalWorktreeRemovalJob(interrupted, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the finish reads only repos and worktree metadata from the store here; git options and push-target cleanup are stubbed or short-circuit without a push target.
      store: storeStub as unknown as Store,
      // Takes the real gate synchronously, as the runtime's does.
      acquireWatcherRemoval: async (path) => {
        const gate = acquireWatcherRemovalGate(path)
        expect(() => beginTerminalInstall(worktreePath)).toThrow(/being removed/)
        return { finish: async () => gate.release() }
      },
      closeWatchers: async () => {},
      preservedBranchCleanup: {
        preserveHead: (result) => result ?? {},
        remember
      },
      purge: ({ worktreeId }) => purged.push(worktreeId),
      onRemoved: () => {},
      publish: () => {}
    })
  )
  const outcome: FinishOutcome = await joined!.then(
    (result) => ({ status: 'removed' as const, ...result }),
    (error: unknown) => ({ status: 'failed' as const, error: String(error) })
  )
  await _settlePendingWorktreeRemovalsForTests()
  const records = await readWorktreeRemovalRecords(recordsDir)
  expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
  // Released on every outcome, including a finish that ended before taking its own gate.
  beginTerminalInstall(worktreePath)()
  return { outcome, purged, remember, records }
}

/** The non-main rows a listing shows, with any failed delete's error. */
async function listedRows(): Promise<{ path: string; removalError?: string }[]> {
  return (await withUnregisteredRemovalCheckouts(repo.id, await listWorktreesStrict(repoPath)))
    .filter((row) => !row.isMainWorktree)
    .map(({ path, removalError }) => ({ path, ...(removalError ? { removalError } : {}) }))
}

describe('finishing an interrupted worktree removal after a restart', () => {
  it('finishes a forced delete Git was still deleting, branch and metadata included', async () => {
    // Git stopped partway: part of the checkout is gone, which reads as local changes.
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(records).toEqual([])
    expect(
      outcome && 'preservedBranch' in outcome ? outcome.preservedBranch : undefined
    ).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('finishes a clean checkout with the recorded non-forced choice', async () => {
    const { outcome, purged, records } = await finishAfterRestart({ force: false })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(records).toEqual([])
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('keeps the user’s non-forced choice: Git refuses local changes and the row returns as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')

    const { outcome, purged, records } = await finishAfterRestart({ force: false })

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/--force/) })
    expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(purged).toEqual([])
    expect(records).toEqual([])
    expect(await listedRows()).toEqual([{ path: worktreePath }])
  })

  it.each([true, false])(
    'unregisters a checkout whose .git Git deleted first, keeping its files (force %s)',
    async (force) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Git deletes in directory order; without `.git` no `worktree remove` can validate it.
      await unlink(join(worktreePath, '.git'))

      const { outcome, purged, records } = await finishAfterRestart({ force })

      const refusal = `Git no longer tracks ${worktreePath}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`
      expect(outcome).toEqual({ status: 'failed', error: `Error: ${refusal}` })
      expect(existsSync(join(worktreePath, '.git'))).toBe(false)
      expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
      expect(removeHostTree).not.toHaveBeenCalled()
      expect(await isRegistered(worktreePath)).toBe(false)
      // The merged branch goes with the registration, as the delete asked.
      expect(await git(['branch', '--list', 'feature'])).toBe('')
      expect(purged).toEqual([])
      expect(records).toMatchObject([{ failure: { message: refusal } }])
      expect(await listedRows()).toEqual([{ path: worktreePath, removalError: refusal }])
    }
  )

  it('keeps the user’s non-forced choice after Git deleted part of the checkout: the row returns as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(join(worktreePath, 'kept.txt'), 'kept\n')
    await git(['add', 'kept.txt'], worktreePath)
    await git(['commit', '-qm', 'kept'], worktreePath)
    // Git stopped partway: some tracked files are gone, `.git` is still there.
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged, records } = await finishAfterRestart({ force: false })

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/--force/) })
    expect(await readFile(join(worktreePath, 'kept.txt'), 'utf8')).toBe('kept\n')
    expect(existsSync(join(worktreePath, '.git'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(purged).toEqual([])
    expect(records).toEqual([])
    expect(await listedRows()).toEqual([{ path: worktreePath }])
  })

  it('deletes nothing in a folder put at the path after Git unregistered the checkout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'remove', worktreePath])
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    const refusal = `Git no longer tracks ${worktreePath}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`
    expect(outcome).toEqual({ status: 'failed', error: `Error: ${refusal}` })
    expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(removeHostTree).not.toHaveBeenCalled()
    // Git let go of the checkout, so the recorded branch delete runs (merged only); no files.
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([])
    expect(records).toMatchObject([{ failure: { message: refusal } }])
    expect(await listedRows()).toEqual([{ path: worktreePath, removalError: refusal }])
  })

  it('leaves a different checkout created at the same path since the quit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'other'])
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')

    const { outcome, purged, records } = await finishAfterRestart({ head, force: true })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(records).toEqual([])
    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(purged).toEqual([])
  })

  it('leaves a repository created at the path after Git unregistered the checkout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'remove', worktreePath])
    await mkdir(worktreePath, { recursive: true })
    await git(['init', '-q'], worktreePath)
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    expect(outcome).toMatchObject({ status: 'failed' })
    // Not the removed checkout's leftover, so no row either, as a listing would decide.
    expect(records).toEqual([])
    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
  })

  it('leaves the same branch checked out again at a new head', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['worktree', 'add', '-q', worktreePath, 'feature'])
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)

    const { outcome, purged, records } = await finishAfterRestart({ head, force: true })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(records).toEqual([])
    expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
    expect(purged).toEqual([])
  })

  it('leaves a locked checkout alone even when its .git file is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'lock', worktreePath])
    await unlink(join(worktreePath, '.git'))

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/locked/) })
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    // Not pruned either: the lock keeps Git's registration.
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(purged).toEqual([])
    expect(records).toEqual([])
  })

  it('deletes the branch when Git finished the checkout but the quit came before the branch', async () => {
    await git(['worktree', 'remove', worktreePath])

    const { outcome, purged, records } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(records).toEqual([])
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('keeps an unmerged branch, as a normal removal does', async () => {
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])

    const { outcome, remember, records } = await finishAfterRestart()

    expect(records).toEqual([])
    expect(outcome).toMatchObject({
      status: 'removed',
      preservedBranch: { branchName: 'feature', head }
    })
    expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
    expect(remember).toHaveBeenCalledWith(
      `repo-1::${worktreePath}`,
      undefined,
      { preservedBranch: { branchName: 'feature', head } },
      head,
      undefined
    )
  })

  it('treats a removal that fully finished as done', async () => {
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['branch', '-d', 'feature'])

    const { outcome, purged, records } = await finishAfterRestart({ head })

    expect(records).toEqual([])
    expect(outcome).toMatchObject({ status: 'removed' })
    expect(
      outcome && 'preservedBranch' in outcome ? outcome.preservedBranch : undefined
    ).toBeUndefined()
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('returns the row live when the finish fails, instead of retrying unseen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Another Git client locked it while Orca was not running.
    await git(['worktree', 'lock', worktreePath])

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(worktreePath)).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(purged).toEqual([])
    expect(records).toEqual([])
    expect(await listedRows()).toEqual([{ path: worktreePath }])
  })

  it('drops a record whose repo Orca no longer has', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { outcome, purged, records } = await finishAfterRestart({ repoGone: true })

    expect(records).toEqual([])
    expect(outcome).toMatchObject({ status: 'removed' })
    expect(purged).toEqual([])
    expect(existsSync(worktreePath)).toBe(true)
  })
})
