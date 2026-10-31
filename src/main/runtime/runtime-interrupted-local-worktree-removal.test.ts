import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
// Use real Git/disk evidence to finish interrupted removal regardless of how far the earlier run progressed.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { getDefaultSettings } from '../../shared/constants'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { buildDetectedGitWorktrees } from '../ipc/worktrees/listing/ssh-worktree-fallback'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Store } from '../persistence'
import type * as HostTreeRemoval from '../host-tree-removal'
import { removeHostTree } from '../host-tree-removal'
import * as nativeFs from '../asar-transparent-fs'
import * as diskFs from 'node:fs/promises'
import * as nativeRemoval from '../git/windows-worktree-removal'
import * as graphReader from '../git/worktree-list-reader'
import { cleanupLocalOrphanedWorktreeDirectory } from '../local-orphaned-worktree-cleanup'
import * as removalOwnership from '../ipc/worktrees/removal/worktree-removal-ownership'
import { executeWorktreeRemoval } from '../ipc/worktrees/removal/execute-worktree-removal'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'
import { OrcaRuntimeWithResolveWorktreeRemovalTarget } from './workspaces/workspace-removal-target'
import type { WorktreeIpcContext } from '../ipc/worktrees/worktree-ipc-context'
import * as backgroundRemoval from '../worktree-background-removal'
import * as worktreeGit from '../git/worktree'
import * as worktreeRemote from '../ipc/worktree-remote'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import * as removalTable from '../worktree-removal-table'
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
import { queueWorkspaceDelete } from './workspaces/workspace-lifecycle-commands'
import { WorkspaceLifecycleQueue } from './workspaces/workspace-lifecycle-queue'
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'

vi.mock('node:fs/promises', async (importOriginal) => {
  return { ...(await importOriginal<typeof diskFs>()) }
})

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: vi.fn(() => ({}))
}))
vi.mock('../host-tree-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof HostTreeRemoval>()
  return { ...actual, removeHostTree: vi.fn(actual.removeHostTree) }
})

vi.mock('../ipc/worktrees/removal/worktree-removal-ownership', () => ({
  stopPtysForDestructiveWorktreeRemoval: vi.fn(async () => {}),
  removeWorktreeMetadataAndTransientState: vi.fn()
}))

const execFileAsync = promisify(execFile)

let scratchDir = ''
let recordsDir = ''
let repoPath = ''
let worktreePath = ''
let repo: Repo
let pushTarget: GitPushTarget | undefined
let lifecycle: WorkspaceLifecycleQueue

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Parse Git paths: Windows output uses forward slashes unlike native joins.
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

beforeEach(async () => {
  pushTarget = undefined
  lifecycle = new WorkspaceLifecycleQueue()
  vi.mocked(getLocalProjectWorktreeGitOptions).mockReturnValue({})
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
  vi.restoreAllMocks()
  vi.mocked(removeHostTree).mockClear()
  vi.mocked(removalOwnership.stopPtysForDestructiveWorktreeRemoval).mockReset()
  await removeTree(scratchDir)
})

type FinishOutcome =
  | ({ status: 'removed' } & RemoveWorktreeResult)
  | { status: 'failed'; error: string }

async function finishAfterRestart(
  options: {
    repoGone?: boolean
    branch?: string
    head?: string
    force?: boolean
    deleteBranch?: boolean
    stopPtys?: () => Promise<void>
  } = {}
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
    branch: options.branch ?? 'feature',
    head: options.head ?? (await git(['rev-parse', 'feature'])).trim(),
    deleteBranch: options.deleteBranch ?? true,
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

  const purged: string[] = []
  const remember = vi.fn()
  const host = removalHost(options.repoGone, options.stopPtys)
  host.purge = ({ worktreeId }) => {
    purged.push(worktreeId)
  }
  host.preservedBranchCleanup.remember = remember
  resumeInterruptedWorktreeRemovals((interrupted) =>
    interruptedLocalWorktreeRemovalJob(interrupted, host)
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
  const rows = await withUnregisteredRemovalCheckouts(repo.id, await listWorktreesStrict(repoPath))
  return buildDetectedGitWorktrees(removalHost().store, repo, rows)
    .filter((row) => row.visible && !row.isMainWorktree)
    .map(({ path, removalError }) => ({ path, ...(removalError ? { removalError } : {}) }))
}

function removalHost(
  repoGone = false,
  stopPtys = async () => {},
  teardown = () => {}
): Parameters<typeof interruptedLocalWorktreeRemovalJob>[1] & { store: Store } {
  const store = {
    getRepo: (id: string) => (id === repo.id && !repoGone ? repo : undefined),
    getRepos: () => (repoGone ? [] : [repo]),
    getWorktreeMeta: () => ({
      ...getProjectHostSetupWorktreeMeta([], repo),
      instanceId: 'removal-fixture',
      orcaCreatedAt: 1,
      orcaCreationSource: 'runtime',
      pushTarget
    }),
    getWorktreeMetaForHost: () => store.getWorktreeMeta(),
    getSettings: () => getDefaultSettings(scratchDir),
    getProjectHostSetups: () => [],
    getAllWorktreeMeta: () => ({})
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal/listing paths read only the supplied store methods; the fixture owns all process/session services.
    store: store as unknown as Store,
    acquireWatcherRemoval: async (path) => {
      teardown()
      const gate = acquireWatcherRemovalGate(path)
      return { finish: async () => gate.release() }
    },
    closeWatchers: vi.fn(async () => teardown()),
    stopPtys,
    preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: vi.fn() },
    purge: () => expect(existsSync(worktreePath)).toBe(false),
    onRemoved: () => {},
    publish: () => {}
  }
}

const deletionOperations = () =>
  (['rm', 'unlink', 'rmdir'] as const).map((operation) => vi.spyOn(nativeFs, operation))

function expectNoTeardownOrDeletion(
  ...callbacks: (ReturnType<typeof vi.fn> | ReturnType<typeof deletionOperations>[number])[]
): void {
  callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled())
}

type RemovalEntry = 'desktop' | 'runtime'

async function deleteViaEntry(
  entry: RemovalEntry,
  force: boolean,
  stop = async () => {},
  teardown = vi.fn(),
  deleteBranch?: boolean
): Promise<unknown> {
  const worktreeId = `repo-1::${worktreePath}`
  const host = removalHost(false, stop, teardown)
  const { store } = host
  const runtime: OrcaRuntimeWithResolveWorktreeRemovalTarget = Object.assign(
    Object.create(OrcaRuntimeWithResolveWorktreeRemovalTarget.prototype),
    {
      store,
      workspaceLifecycle: lifecycle,
      listRepos: store.getRepos,
      listTerminals: async () => ({ totalCount: 0 }),
      requireStore: () => store,
      resolveWorktreeRemovalTarget: async () => ({
        id: worktreeId,
        repoId: repo.id,
        path: worktreePath
      }),
      removeManagedWorktreeInFlight: new RuntimeWorktreeRemovalInFlight(),
      localRemovalJobHost: () => host,
      acquireFileWatcherRemoval: host.acquireWatcherRemoval,
      stopPtysForDestructiveWorktreeRemoval: stop,
      closeFileWatchersForRemoval: host.closeWatchers,
      preservedBranchCleanup: { ...host.preservedBranchCleanup, delete: vi.fn() },
      purgeRemovedWorktree: host.purge,
      clearOptimisticReconcileToken: () => {},
      publishWorktreeRemovalChange: () => {},
      notifyWorktreesChanged: () => {},
      emitWorktreeLifecycle: () => {}
    }
  )
  vi.mocked(removalOwnership.stopPtysForDestructiveWorktreeRemoval).mockImplementation(stop)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native dispatch reads only the fixture-owned context fields below.
  const context = {
    store,
    runtime,
    mainWindow: { isDestroyed: () => true }
  } as unknown as WorktreeIpcContext
  try {
    const accepted =
      entry === 'desktop'
        ? await executeWorktreeRemoval(
            context,
            { worktreeId, force },
            repo,
            repo.id,
            worktreePath,
            'local'
          )
        : await queueWorkspaceDelete(
            runtime,
            `id:${worktreeId}`,
            'local',
            { force, deleteBranch },
            (removal) =>
              runtime.removeManagedWorktree(`id:${worktreeId}`, {
                ...removal,
                waitForBackgroundRemoval: true
              })
          )
    return await backgroundRemoval.finishAcceptedWorktreeRemoval(accepted, worktreeId)
  } finally {
    await _settlePendingWorktreeRemovalsForTests()
  }
}

async function orphanAdmin(): Promise<void> {
  const admin = (await readFile(join(worktreePath, '.git'), 'utf8')).trim().replace(/^gitdir: /, '')
  await removeTree(admin)
  await unlink(join(worktreePath, '.git'))
  await writeFile(join(worktreePath, '.git'), `  gitdir: ${admin}\nignored second line\n`)
}

async function recordFailedRemoval(force: boolean, deleteBranch = true): Promise<void> {
  await writeWorktreeRemovalRecords(recordsDir, () => [
    {
      worktreeId: `repo-1::${worktreePath}`,
      repoId: repo.id,
      repoPath,
      worktreePath,
      branch: 'feature',
      head: '',
      deleteBranch,
      force,
      requestedAt: 1,
      failure: { message: 'held file', failedAt: 2 }
    }
  ])
  await loadWorktreeRemovalRecords(recordsDir)
}

describe('finishing an interrupted worktree removal after a restart', () => {
  it('refuses an unknown owner through both entries, admission, cleanup and failed listing', async () => {
    await orphanAdmin()
    const movedOwner = join(scratchDir, 'ENOENT')
    await rename(repoPath, movedOwner)
    repoPath = movedOwner
    repo.path = repoPath
    await writeFile(join(repoPath, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(
      join(worktreePath, '.git'),
      `gitdir: ${join(repoPath, 'worktrees', 'feature')}\n`
    )
    // Successful graph seams isolate proof propagation, not a live permission exploit.
    vi.spyOn(worktreeGit, 'listWorktreesStrict').mockResolvedValue([])
    vi.spyOn(graphReader, 'readTranslatedWorktreeGraph').mockResolvedValue([])
    const stat = diskFs.stat
    vi.spyOn(diskFs, 'stat').mockImplementation(async (path, options) => {
      if (String(path) === join(repoPath, '.git')) {
        throw Object.assign(new Error(`EACCES: permission denied, stat '${String(path)}'`), {
          code: 'EACCES'
        })
      }
      return stat(path, options)
    })
    const stop = vi.fn(async () => {})
    const teardown = vi.fn()
    const operations = deletionOperations()
    await expect(
      nativeRemoval.removeWindowsCheckout(repoPath, worktreePath, true, {})
    ).rejects.toThrow('Refusing to delete unregistered worktree path')
    // Reach both nonnative unregistered consumers after independently checking native admission.
    vi.spyOn(nativeRemoval, 'usesNativeWindowsRemoval').mockReturnValue(false)
    const metadata = vi.mocked(removalOwnership.removeWorktreeMetadataAndTransientState)
    metadata.mockClear()
    const pushCleanup = vi.spyOn(worktreeRemote, 'cleanupUnusedWorktreePushTargetRemote')
    for (const entry of ['desktop', 'runtime'] as const) {
      await expect(deleteViaEntry(entry, true, stop, teardown)).rejects.toThrow(
        'Refusing to delete unregistered worktree path'
      )
    }
    await expect(
      cleanupLocalOrphanedWorktreeDirectory(repoPath, worktreePath, {}, stop)
    ).rejects.toThrow('Worktree is no longer registered with Git but its directory remains.')
    expectNoTeardownOrDeletion(stop, teardown, ...operations)
    expect(removeHostTree).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    expect(pushCleanup).not.toHaveBeenCalled()
    expect(await readFile(join(worktreePath, 'seed.txt'), 'utf8')).toBe('seed\n')
    await recordFailedRemoval(true)
    expect(await readWorktreeRemovalRecords(recordsDir)).toMatchObject([
      { worktreePath, failure: { message: 'held file' } }
    ])
    expect(await listedRows()).toEqual([])
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([]))
    expect(await readFile(join(worktreePath, 'seed.txt'), 'utf8')).toBe('seed\n')
  })

  it.skipIf(process.platform !== 'win32').each([
    { entry: 'desktop', phase: 'child' },
    { entry: 'runtime', phase: 'child' },
    { entry: 'desktop', phase: 'root' },
    { entry: 'runtime', phase: 'root' }
  ] as const)(
    '$entry completes explicit retry after releasing held $phase across restart',
    async ({ entry, phase }) => {
      const remoteUrl = 'https://example.invalid/repo.git'
      pushTarget = {
        remoteName: 'pr-contributor',
        branchName: 'feature',
        remoteCreated: true,
        remoteUrl
      }
      await git(['remote', 'add', pushTarget.remoteName, remoteUrl])
      await git(['config', `remote.${pushTarget.remoteName}.orca-created`, 'true'])
      const sibling = join(scratchDir, 'temporarily-missing')
      await git(['worktree', 'add', '-q', sibling, '-b', 'sibling'])
      await rename(sibling, join(scratchDir, 'offline'))
      const path = phase === 'child' ? join(worktreePath, 'seed.txt') : worktreePath
      const locked = Object.assign(new Error('held path'), { code: 'EBUSY', path })
      const held = vi.spyOn(nativeFs, phase === 'child' ? 'rm' : 'rmdir').mockRejectedValue(locked)
      const { outcome, records } = await finishAfterRestart({ force: true })
      const message = `${path} is open in another program. Close that program and delete again.`
      expect(outcome.status).toBe('failed')
      expect(records).toMatchObject([{ failure: { message } }])
      if (phase === 'root') {
        expect((await listWorktreesStrict(repoPath)).filter((row) => row.prunable)).toHaveLength(2)
      }
      expect(await listedRows()).toEqual([{ path: worktreePath, removalError: message }])
      expect(await git(['remote'])).toContain(pushTarget.remoteName)
      expect(await isRegistered(worktreePath)).toBe(true)
      expect(await git(['branch', '--list', 'feature'])).not.toBe('')
      _resetPendingWorktreeRemovalsForTests()
      await loadWorktreeRemovalRecords(recordsDir)
      expect(await listedRows()).toEqual([{ path: worktreePath, removalError: message }])
      const resume = vi.fn()
      resumeInterruptedWorktreeRemovals(resume)
      expect(resume).not.toHaveBeenCalled()
      await expect(deleteViaEntry(entry, true)).rejects.toThrow()
      expect(await isRegistered(worktreePath)).toBe(true)
      held.mockRestore()
      await deleteViaEntry(entry, true)
      expect(existsSync(worktreePath)).toBe(false)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect(await git(['branch', '--list', 'feature'])).toBe('')
      expect(await git(['remote'])).not.toContain(pushTarget.remoteName)
      expect(await isRegistered(sibling)).toBe(true)
      expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
    },
    60_000
  )

  it
    .skipIf(process.platform !== 'win32')
    .each(
      (['desktop', 'runtime'] as const).flatMap((entry) =>
        ['native', 'wsl'].map((route) => ({ entry, route }))
      )
    )(
    '$entry refuses $route before publication/teardown and honors current native force',
    async ({ entry, route }) => {
      const seed = await readFile(join(worktreePath, 'seed.txt'))
      await orphanAdmin()
      if (route === 'wsl') {
        await unlink(join(worktreePath, '.git'))
        vi.mocked(getLocalProjectWorktreeGitOptions).mockReturnValue({ wslDistro: 'Ubuntu' })
        // A route-list seam, not a distro run: the request must refuse before invoking a job.
        vi.spyOn(worktreeGit, 'listWorktreesStrict').mockResolvedValue([])
      }
      const retryJob = vi.spyOn(backgroundRemoval, 'retryFailedWorktreeRemoval')
      const pushCleanup = vi.spyOn(worktreeRemote, 'cleanupUnusedWorktreePushTargetRemote')
      await recordFailedRemoval(true)
      const stop = vi.fn(async () => {})
      const teardown = vi.fn()
      const operations = deletionOperations()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(deleteViaEntry(entry, false, stop, teardown)).rejects.toThrow(
          /no longer (?:registered|a Git worktree)/
        )
        expect(retryJob).not.toHaveBeenCalled()
        expect(pushCleanup).not.toHaveBeenCalled()
        expectNoTeardownOrDeletion(stop, teardown, ...operations)
        expect(await readFile(join(worktreePath, 'seed.txt'))).toEqual(seed)
        expect(await readWorktreeRemovalRecords(recordsDir)).toMatchObject([
          { force: true, failure: { message: 'held file' } }
        ])
        _resetPendingWorktreeRemovalsForTests()
        await loadWorktreeRemovalRecords(recordsDir)
      }
      if (route === 'wsl') {
        return
      }
      const sibling = join(scratchDir, 'temporarily-missing')
      await git(['worktree', 'add', '-q', sibling, '-b', 'sibling'])
      await rename(sibling, join(scratchDir, 'offline'))
      await recordFailedRemoval(false)
      const started = Promise.withResolvers<void>()
      const paused = Promise.withResolvers<void>()
      const retry = deleteViaEntry(entry, true, async () => {
        started.resolve()
        await paused.promise
      }).catch((error: unknown) => error)
      try {
        await started.promise
        expect([...removalTable.pendingWorktreeRemovals.values()]).toMatchObject([
          { force: true, branch: 'feature', deleteBranch: true }
        ])
        expect(await readWorktreeRemovalRecords(recordsDir)).toMatchObject([{ force: true }])
      } finally {
        paused.resolve()
      }
      expect(await retry).not.toBeInstanceOf(Error)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect(await isRegistered(sibling)).toBe(true)
      expect(await git(['branch', '--list', 'feature'])).toBe('')
      await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
      await removeTree(worktreePath)
      expect(await isRegistered(worktreePath)).toBe(true)
      await deleteViaEntry(entry, true)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect(await isRegistered(sibling)).toBe(true)
      expect(await git(['branch', '--list', 'feature'])).toBe('')
    }
  )

  it.skipIf(process.platform !== 'win32').each(
    (['desktop', 'runtime'] as const).flatMap((entry) =>
      ['attached', 'detached', 'folder', 'nested'].map((schedule) => ({
        entry,
        schedule
      }))
    )
  )(
    '$entry preserves $schedule replacements before/after teardown',
    async ({ entry, schedule }) => {
      await orphanAdmin()
      await loadWorktreeRemovalRecords(recordsDir)
      const change = async () => {
        if (schedule === 'nested') {
          await git(['worktree', 'add', '-q', join(worktreePath, 'nested'), '-b', 'nested'])
        } else {
          await rename(worktreePath, join(scratchDir, 'original'))
          await (schedule === 'folder'
            ? mkdir(worktreePath)
            : git([
                'worktree',
                'add',
                '-q',
                ...(schedule === 'detached' ? ['--detach'] : ['-b', 'other']),
                worktreePath
              ]))
        }
        await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')
      }
      const stop = vi.fn(change)
      const teardown = vi.fn()
      await expect(deleteViaEntry(entry, true, stop, teardown)).rejects.toThrow()
      expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
      expect(stop).toHaveBeenCalledOnce()
      // A second ordinary Delete refuses proofless/nested contents before teardown.
      if (['folder', 'nested'].includes(schedule)) {
        stop.mockClear()
        teardown.mockClear()
        const operations = deletionOperations()
        await expect(deleteViaEntry(entry, true, stop, teardown)).rejects.toThrow()
        expectNoTeardownOrDeletion(stop, teardown, ...operations)
        expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
      }
    }
  )

  it.each(['partial', 'detached', 'keep-registered', 'keep-unregistered'])(
    'finishes the accepted %s pending checkout after restart',
    async (kind) => {
      const head = (await git(['rev-parse', 'feature'])).trim()
      if (kind === 'keep-unregistered') {
        await git(['worktree', 'remove', worktreePath])
      }
      const keep = kind.startsWith('keep-')
      if (!keep) {
        await (kind === 'partial'
          ? unlink(join(worktreePath, 'seed.txt'))
          : git(['checkout', '--detach', '-q'], worktreePath))
      }
      const { outcome, purged, records } = await finishAfterRestart({
        force: kind === 'partial',
        branch: kind === 'detached' ? '' : 'feature',
        head: keep ? head : (await git(['rev-parse', 'HEAD'], worktreePath)).trim(),
        deleteBranch: keep ? false : undefined
      })
      expect(outcome).toMatchObject({ status: 'removed' })
      expect(records).toEqual([])
      expect(existsSync(worktreePath)).toBe(false)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect((await git(['branch', '--list', 'feature'])).trim() !== '').toBe(
        keep || kind === 'detached'
      )
      expect(purged).toEqual([`repo-1::${worktreePath}`])
      if (keep) {
        expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
        expect(outcome).not.toHaveProperty('preservedBranch')
      }
    }
  )

  it.each([false, undefined])(
    'settles persisted failed keep through lifecycle retry, intent=%s',
    async (intent) => {
      const head = (await git(['rev-parse', 'feature'])).trim()
      await git(['worktree', 'remove', worktreePath])
      await mkdir(worktreePath)
      await writeFile(join(worktreePath, 'leftover'), 'held')
      await recordFailedRemoval(false, false)
      const id = `repo-1::${worktreePath}`
      const record = removalTable.failedWorktreeRemovals.get(id)
      expect(record).toMatchObject({ deleteBranch: false, failure: { message: 'held file' } })
      await expect(deleteViaEntry('runtime', false, undefined, undefined, intent)).rejects.toThrow(
        'folder was left on disk'
      )
      expect(removalTable.failedWorktreeRemovals.get(id)).toBe(record)
      expect(lifecycle.hints()).toEqual({})
      // Removing only this fixture's leftover is the legitimate external wake for retry.
      await removeTree(worktreePath)
      await expect(deleteViaEntry('runtime', false, undefined, undefined, true)).rejects.toThrow(
        'different branch choice'
      )
      expect(removalTable.failedWorktreeRemovals.get(id)).toBe(record)
      expect(lifecycle.hints()).toEqual({})
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const stopPtys = async () => {
        entered.resolve()
        await release.promise
      }
      const retry = deleteViaEntry('runtime', false, stopPtys, undefined, intent)
      try {
        await entered.promise
        expect(removalTable.pendingWorktreeRemovals.get(id)).toMatchObject({ deleteBranch: false })
        expect(removalTable.failedWorktreeRemovals.has(id)).toBe(false)
      } finally {
        release.resolve()
      }
      const result = await retry
      expect(result).not.toHaveProperty('preservedBranch')
      expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect(existsSync(worktreePath)).toBe(false)
      expect(waitForPendingWorktreeRemoval(id)).toBeUndefined()
      expect(removalTable.failedWorktreeRemovals.has(id)).toBe(false)
      expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
      expect(lifecycle.hints()).toEqual({})
    }
  )

  it('keeps the user’s non-forced choice: Git refuses local changes and the row returns as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')

    const { outcome, purged, records } = await finishAfterRestart({ force: false })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(await readFile(join(worktreePath, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(purged).toEqual([])
    expect(records).toMatchObject([{ failure: { message: expect.any(String) } }])
    expect(await listedRows()).toEqual([{ path: worktreePath, removalError: expect.any(String) }])
  })

  it.each([true, false])(
    'preserves a nonempty markerless checkout and platform cleanup policy (force %s)',
    async (force) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const admin = (await readFile(join(worktreePath, '.git'), 'utf8')).trim().slice(8)
      const backlink = await readFile(join(admin, 'gitdir'), 'utf8')
      const branchHead = await git(['rev-parse', 'feature'])
      // Git deletes in directory order; without `.git` no `worktree remove` can validate it.
      await unlink(join(worktreePath, '.git'))

      const { outcome, purged, records } = await finishAfterRestart({ force })

      const refusal = `${worktreePath} is no longer a Git worktree, so its folder was left on disk. Delete the folder yourself to finish removing this workspace.`
      expect(outcome).toEqual({ status: 'failed', error: `Error: ${refusal}` })
      const native = process.platform === 'win32'
      if (native && force) {
        await expect(deleteViaEntry('runtime', force)).rejects.toThrow(refusal)
        await removalTable.persistWorktreeRemovalRecords()
        expect(await readWorktreeRemovalRecords(recordsDir)).toEqual(records)
        expect(await readFile(join(admin, 'gitdir'), 'utf8')).toBe(backlink)
        expect(await git(['rev-parse', 'feature'])).toBe(branchHead)
      }
      expect(existsSync(join(worktreePath, '.git'))).toBe(false)
      expect(await readFile(join(worktreePath, 'seed.txt'), 'utf8')).toBe('seed\n')
      expect(removeHostTree).not.toHaveBeenCalled()
      expect(await isRegistered(worktreePath)).toBe(native)
      expect((await git(['branch', '--list', 'feature'])).trim() !== '').toBe(native)
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

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(await readFile(join(worktreePath, 'kept.txt'), 'utf8')).toBe('kept\n')
    expect(existsSync(join(worktreePath, '.git'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
    expect(await git(['branch', '--list', 'feature'])).not.toBe('')
    expect(purged).toEqual([])
    expect(records).toMatchObject([{ failure: { message: expect.any(String) } }])
    expect(await listedRows()).toEqual([{ path: worktreePath, removalError: expect.any(String) }])
  })

  it('deletes nothing in a folder put at the path after Git unregistered the checkout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await git(['worktree', 'remove', worktreePath])
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, 'notes.txt'), 'mine\n')

    const { outcome, purged, records } = await finishAfterRestart({ force: true })

    const refusal = `${worktreePath} is no longer a Git worktree, so its folder was left on disk. Delete the folder yourself to finish removing this workspace.`
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
    expect(records).toMatchObject([{ failure: { message: expect.any(String) } }])
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
    expect(records).toMatchObject([{ failure: { message: expect.any(String) } }])
    expect(await listedRows()).toEqual([{ path: worktreePath, removalError: expect.any(String) }])
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

installRealWorkerThreadChildProcesses()
