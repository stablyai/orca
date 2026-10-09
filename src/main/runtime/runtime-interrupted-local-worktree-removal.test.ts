// Real-binary coverage for finishing a removal a quit or crash interrupted: what is left has to
// come from Git and disk, whatever point the earlier run reached.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, unlink, writeFile } from 'node:fs/promises'
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
import type * as WorktreeGitFileRestore from '../git/worktree-git-file-restore'
import { restoreMissingWorktreeGitFile } from '../git/worktree-git-file-restore'
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
vi.mock('../git/worktree-git-file-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeGitFileRestore>()
  return {
    ...actual,
    restoreMissingWorktreeGitFile: vi.fn(actual.restoreMissingWorktreeGitFile)
  }
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

async function finishAfterRestart(options: { repoGone?: boolean; head?: string } = {}): Promise<{
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
    force: false,
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
  // Never left pending; only a refused finish keeps a record, carrying Git's reason.
  expect(records.filter((left) => !left.failure)).toEqual([])
  if (outcome.status === 'removed') {
    expect(records).toEqual([])
  }
  expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
  // Released on every outcome, including a finish that ended before taking its own gate.
  beginTerminalInstall(worktreePath)()
  return { outcome, purged, remember, records }
}

describe('finishing an interrupted worktree removal after a restart', () => {
  it('finishes a checkout Git was still deleting, branch and metadata included', async () => {
    // Git stopped partway: part of the checkout is gone, which reads as local changes.
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(
      outcome && 'preservedBranch' in outcome ? outcome.preservedBranch : undefined
    ).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('lets Git finish a checkout whose .git file it had already deleted', async () => {
    // Git deletes in directory order; without `.git` it refuses the checkout ("validation failed").
    await unlink(join(worktreePath, '.git'))
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
    // Git's process deleted it, not Orca's.
    expect(removeHostTree).not.toHaveBeenCalled()
  })

  it('lets Git finish a relative-path checkout whose .git file it had already deleted', async (ctx) => {
    await git(['worktree', 'remove', worktreePath])
    try {
      await git(['worktree', 'add', '-q', '--relative-paths', worktreePath, 'feature'])
    } catch {
      // Git before 2.48 has no relative-path worktrees.
      ctx.skip()
    }
    await unlink(join(worktreePath, '.git'))
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(purged).toEqual([`repo-1::${worktreePath}`])
    expect(removeHostTree).not.toHaveBeenCalled()
  })

  it('deletes the leftover itself only when Git cannot be pointed back at it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await unlink(join(worktreePath, '.git'))
    vi.mocked(restoreMissingWorktreeGitFile).mockResolvedValueOnce(false)

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(removeHostTree).toHaveBeenCalledWith(worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('leaves a different checkout created at the same path since the quit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'other'])
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')

    const { outcome, purged, records } = await finishAfterRestart({ head })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(purged).toEqual([])
    // Not this removal's checkout: no record of it.
    expect(records).toEqual([])
  })

  it('leaves a repository created at the path after Git unregistered the checkout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'remove', worktreePath])
    await mkdir(worktreePath, { recursive: true })
    await git(['init', '-q'], worktreePath)
    await writeFile(join(worktreePath, 'unsaved.txt'), 'work\n')

    const { outcome, purged, records } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(join(worktreePath, 'unsaved.txt'))).toBe(true)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(purged).toEqual([])
    // Not this removal's checkout: no record of it.
    expect(records).toEqual([])
  })

  it('leaves the same branch checked out again at a new head', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['worktree', 'add', '-q', worktreePath, 'feature'])
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)

    const { outcome, purged, records } = await finishAfterRestart({ head })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
    expect(purged).toEqual([])
    // Not this removal's checkout: no record of it.
    expect(records).toEqual([])
  })

  it('leaves a locked checkout alone even when its .git file is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'lock', worktreePath])
    await unlink(join(worktreePath, '.git'))

    const { outcome, purged, records } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(purged).toEqual([])
    // Git refused and still registers it: the record keeps Git's reason for a caller polling.
    expect(records).toEqual([
      expect.objectContaining({ failure: expect.objectContaining({ message: expect.any(String) }) })
    ])
  })

  it('deletes the branch when Git finished the checkout but the quit came before the branch', async () => {
    await git(['worktree', 'remove', worktreePath])

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('keeps an unmerged branch, as a normal removal does', async () => {
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])

    const { outcome, remember } = await finishAfterRestart()

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

    const { outcome, purged } = await finishAfterRestart({ head })

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

    const { outcome, purged, records } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(worktreePath)).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(purged).toEqual([])
    // Git refused and still registers it: the record keeps Git's reason for a caller polling.
    expect(records).toEqual([
      expect.objectContaining({ failure: expect.objectContaining({ message: expect.any(String) }) })
    ])
  })

  it('drops a record whose repo Orca no longer has', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { outcome, purged } = await finishAfterRestart({ repoGone: true })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(purged).toEqual([])
    expect(existsSync(worktreePath)).toBe(true)
  })
})
