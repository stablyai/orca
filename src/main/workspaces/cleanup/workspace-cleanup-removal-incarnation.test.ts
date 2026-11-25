import { spawnProcessOnWorkerThread } from '../../worker-thread-child-process/worker-thread-child-process'
import { captureWorktreeCheckoutIdentity } from '../removal/worktree-checkout-identity'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState
} from '../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { WorkspaceLifecycleQueue } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-queue'
import { queueWorkspaceDelete } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import {
  invalidateWorktreeCatalogForRepo,
  retireObsoleteWorktreeCatalogs
} from '../catalog/repo-worktree-catalog-owner'
import {
  drainBackgroundWorktreeRemovals,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  waitForPendingWorktreeRemoval
} from '../removal/worktree-background-removal'
import { WorktreeRemovalNotStartedError } from '../removal/worktree-removal-expectation'
import { admitWorkspaceCleanup } from './workspace-cleanup-admission'
import { pinWorkspacesForCleanup } from './workspace-cleanup-pin'
import { collectWorkspaceCleanupWorkspaces } from './workspace-cleanup-run-evidence'
import { removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'
import * as gitExec from '../../git/command-runner/git-exec-file'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../removal/worktree-removal-records'
import { interruptedLocalWorktreeRemovalJob } from '../../runtime/workspaces/removal/runtime-interrupted-local-worktree-removal'
import { readCheckoutMarkerState } from '../removal/worktree-removal-gitdir-identity'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  app: { getPath: () => testState.dir, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const worker = installRealWorkerThreadChildProcesses({ latchRemoval: true })
const old = Date.UTC(2026, 9, 1)
class RemovalRuntime extends OrcaRuntimeService {
  override readonly workspaceLifecycle: WorkspaceLifecycleQueue | null
  constructor(store: ReturnType<typeof createStore>, queued: boolean) {
    super(store)
    this.workspaceLifecycle = queued ? new WorkspaceLifecycleQueue() : null
  }
}
beforeEach(async () => {
  testState.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cleanup-incarnation-')))
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1))
  await loadWorktreeRemovalRecords(testState.dir)
})
// Each case's worktree id carries its own temp path, so settled jobs and records can't leak into the next.
const settleRemovals = () => drainBackgroundWorktreeRemovals().catch(() => {})
afterEach(async () => {
  await settleRemovals()
  await closeTestStores()
  invalidateWorktreeCatalogForRepo('repo')
  retireObsoleteWorktreeCatalogs()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
async function fixture(queued: boolean) {
  const root = join(testState.dir, 'repo'),
    path = join(testState.dir, 'checkout')
  const git = (...args: string[]) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: testState.dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: new Date(old).toISOString(),
        GIT_COMMITTER_DATE: new Date(old).toISOString()
      }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  git('init', '-q', root)
  git('-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git('-C', root, 'config', 'user.name', 'Fixture')
  git('-C', root, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'tracked'), 'seed')
  git('-C', root, 'add', '.')
  git('-C', root, 'commit', '-qm', 'seed')
  git('-C', root, 'worktree', 'add', '-qb', 'topic', path)
  const store = createStore(),
    id = `repo::${path}`,
    target = hostWorktreeTarget({ id, hostId: 'local' })
  const repo = { id: 'repo', path: root, displayName: 'Fixture', badgeColor: 'gray', addedAt: 1 }
  const rules = { ...getDefaultWorkspaceCleanupRules(), unchanged: { enabled: true, afterDays: 1 } }
  store.addRepo(repo)
  store.updateSettings({ workspaceCleanupPolicy: rules })
  store.setWorktreeMeta(target, {
    instanceId: 'A',
    createdAt: old,
    lastActivityAt: old,
    isPinned: false
  })
  const runtime = new RemovalRuntime(store, queued)
  vi.spyOn(runtime, 'machineNameReady').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [],
    truncated: false,
    totalCount: 0
  })
  vi.spyOn(runtime, 'stopPtysForDestructiveWorktreeRemoval').mockResolvedValue(undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only terminal inventory is stubbed; removal, Git, Store and both queues are real.
  vi.spyOn(runtime, 'getLocalProvider').mockReturnValue({ listProcesses: async () => [] } as never)
  const ref = {
    worktreeId: id,
    instanceId: 'A',
    repoId: 'repo',
    repoName: 'Fixture',
    displayName: 'topic',
    path,
    branch: 'topic',
    executionHostId: 'local' as const
  }
  const admit = () =>
    admitWorkspaceCleanup(store, ref, () =>
      queueWorkspaceDelete(
        runtime,
        `id:${id}`,
        'local',
        { expectedWorktree: { worktreeId: id, instanceId: 'A' } },
        (options) =>
          runtime.removeManagedWorktree(`id:${id}`, { ...options, waitForBackgroundRemoval: true })
      )
    )
  return { root, path, git, store, id, target, repo, rules, runtime, ref, admit }
}
it('refuses a persisted deletion of A after a real replacement', async () => {
  const f = await fixture(false)
  const checkoutIdentity = await captureWorktreeCheckoutIdentity(f.path, 'A', f.root)
  const head = f.git('-C', f.path, 'rev-parse', 'HEAD')
  f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
  f.git('-C', f.root, 'worktree', 'add', f.path, 'topic')
  await writeWorktreeRemovalRecords(testState.dir, () => [
    {
      worktreeId: f.id,
      repoId: 'repo',
      repoPath: f.root,
      worktreePath: f.path,
      branch: 'topic',
      head,
      deleteBranch: true,
      force: false,
      requestedAt: old,
      expectedInstanceId: 'A',
      expectedCheckoutIdentity: checkoutIdentity
    }
  ])
  const [record] = await readWorktreeRemovalRecords(testState.dir)
  if (!record) {
    throw new Error('Missing persisted removal')
  }
  const job = interruptedLocalWorktreeRemovalJob(record, {
    store: f.store,
    acquireWatcherRemoval: f.runtime.acquireFileWatcherRemoval,
    closeWatchers: async () => {},
    preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: () => {} },
    purge: () => f.store.removeWorktreeMeta(f.target),
    onRemoved: () => {},
    publish: () => {}
  })
  await loadWorktreeRemovalRecords(testState.dir)
  const pending = waitForPendingWorktreeRemoval(f.id)
  if (!pending) {
    throw new Error('Missing recovered removal')
  }
  resumeInterruptedWorktreeRemovals(() => job)
  await expect(pending).rejects.toThrow()
  await settleRemovals()
  expect(await readWorktreeRemovalRecords(testState.dir)).toEqual([])
  expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
  expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({
    instanceId: 'A',
    isPinned: false
  })
})
it('retires a proven Git preflight refusal before Keep or another cleanup', async () => {
  const f = await fixture(false)
  writeFileSync(join(f.path, 'tracked'), 'unsaved fixture edit')
  const attempt = await f.admit()
  if (!attempt.admitted) {
    throw new Error('Expected admission')
  }
  await expect(attempt.completion).rejects.toBeInstanceOf(WorktreeRemovalNotStartedError)
  expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('unsaved fixture edit')
  expect(await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'A' }])).toEqual(
    { pinned: [f.id], deleted: [], failed: [], tooLate: [] }
  )
  expect(
    Object.values(readPersistedState().worktreeMeta).find((row) => row.instanceId === 'A')?.isPinned
  ).toBe(true)
  expect(await f.admit()).toEqual({ admitted: false, cause: 'pinned' })
  f.store.setWorktreeMeta(f.target, { isPinned: false })
  f.git('-C', f.path, 'checkout', '--', 'tracked')
  const retry = await f.admit()
  if (!retry.admitted) {
    throw new Error('Expected fresh admission')
  }
  await retry.completion
  expect(existsSync(f.path)).toBe(false)
  expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toBeUndefined()
})
it('retains the removal fence after an uncertain partial deletion settles', async () => {
  const f = await fixture(false)
  const original = gitExec.gitExecFileAsync
  const injection = vi
    .spyOn(gitExec, 'gitExecFileAsync')
    .mockImplementation(async (args, options) => {
      if (args.includes('worktree') && args.includes('remove')) {
        rmSync(join(f.path, 'tracked'))
      }
      return original(args, options)
    })
  try {
    const attempt = await f.admit()
    if (!attempt.admitted) {
      throw new Error('Expected admission')
    }
    await expect(attempt.completion).rejects.not.toBeInstanceOf(WorktreeRemovalNotStartedError)
    expect(existsSync(join(f.path, 'tracked'))).toBe(false)
    expect(
      await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'A' }])
    ).toEqual({ pinned: [], deleted: [], failed: [], tooLate: [f.id] })
    expect(await f.admit()).toEqual({ admitted: false, cause: 'removing' })
  } finally {
    injection.mockRestore()
  }
})
it('refuses a real replacement after worker dispatch and before spawn', async () => {
  const f = await fixture(false)
  const workspace = (
    await collectWorkspaceCleanupWorkspaces({
      store: f.store,
      runtime: f.runtime,
      globalRules: f.rules,
      now: Date.now()
    })
  ).find((row) => row.ref.worktreeId === f.id)
  if (!workspace) {
    throw new Error('Missing fixture workspace')
  }
  const dispatched = worker.holdRemoval()
  const removal = removeWorkspaceForCleanup({
    store: f.store,
    runtime: f.runtime,
    workspace,
    globalRules: () => f.rules,
    now: Date.now
  })
  try {
    await Promise.race([
      dispatched,
      removal.then(() => {
        throw new Error('Removal never reached the worker queue')
      })
    ])
    f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
    f.git('-C', f.root, 'worktree', 'add', f.path, 'topic')
  } finally {
    worker.releaseRemoval()
  }
  expect(await removal).toMatchObject({ outcome: 'failed' })
  expect(existsSync(f.path)).toBe(true)
  expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
  expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({
    instanceId: 'A',
    isPinned: false
  })
})
it('refuses a valid checkout proof attached to a different Git removal target', async () => {
  const f = await fixture(false)
  const proof = await captureWorktreeCheckoutIdentity(f.path, 'A', f.root)
  const other = join(testState.dir, 'other-checkout')
  f.git('-C', f.root, 'worktree', 'add', '-qb', 'other', other)
  const error = await new Promise<unknown>((resolve) => {
    const child = spawnProcessOnWorkerThread({
      program: 'git',
      args: ['worktree', 'remove', other],
      cwd: f.root,
      worktreeCheckoutGuard: { identity: proof }
    })
    child.once('error', resolve)
    child.once('close', () => resolve(null))
  })
  expect(error).toMatchObject({ code: 'ERR_ORCA_WORKTREE_CHANGED' })
  expect(readFileSync(join(other, 'tracked'), 'utf8')).toBe('seed')
})

/** A cleanup removal recorded as failed after Git, as the failure row Retry is offered on. */
async function failedCleanupRecord(f: Awaited<ReturnType<typeof fixture>>) {
  const checkoutIdentity = await captureWorktreeCheckoutIdentity(f.path, 'A', f.root)
  const marker = await readCheckoutMarkerState(f.path)
  return {
    worktreeId: f.id,
    repoId: 'repo',
    repoPath: f.root,
    worktreePath: f.path,
    branch: 'topic',
    head: f.git('-C', f.path, 'rev-parse', 'HEAD'),
    ...(marker.kind === 'file' ? { gitdir: marker.identity } : {}),
    deleteBranch: true,
    force: false,
    requestedAt: old,
    expectedInstanceId: 'A',
    expectedCheckoutIdentity: checkoutIdentity
  }
}
const branchExists = (f: Awaited<ReturnType<typeof fixture>>) =>
  runProcessSync({
    program: 'git',
    args: ['-C', f.root, 'show-ref', '--verify', '--quiet', 'refs/heads/topic'],
    cwd: testState.dir
  }).code === 0

it.each(['empty', 'gone', 'marked', 'files', 'recreated', 'unforced'] as const)(
  'Retry finishes what a cleanup removal left behind like a manual delete (%s leftover)',
  async (leftover) => {
    const f = await fixture(false)
    const record = await failedCleanupRecord(f)
    if (leftover === 'marked' || leftover === 'unforced') {
      // Git dropped the registration; the folder still names the removed admin entry.
      rmSync(join(f.root, '.git', 'worktrees', 'checkout'), { recursive: true, force: true })
    } else if (leftover === 'empty') {
      // Git emptied A's own root, marker included, and dropped its registration.
      for (const name of readdirSync(f.path)) {
        rmSync(join(f.path, name), { recursive: true, force: true })
      }
      f.git('-C', f.root, 'worktree', 'prune')
    } else {
      f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
      if (leftover !== 'gone') {
        // A folder made at the path after A's root was gone.
        mkdirSync(f.path)
      }
      if (leftover === 'files') {
        writeFileSync(join(f.path, 'notes'), 'not the removed checkout')
      }
    }
    await writeWorktreeRemovalRecords(testState.dir, () => [
      { ...record, failure: { message: 'The checkout remains after Git deletion.', failedAt: old } }
    ])
    await loadWorktreeRemovalRecords(testState.dir)
    // The runtime Retry entry: a marked orphan still needs the user's force, an empty root does not.
    const retry = f.runtime.removeManagedWorktree(`id:${f.id}`, {
      force: leftover === 'marked',
      waitForBackgroundRemoval: true
    })
    if (leftover === 'files' || leftover === 'recreated' || leftover === 'unforced') {
      await expect(retry).rejects.toThrow()
      await settleRemovals()
      expect(existsSync(f.path)).toBe(true)
      if (leftover === 'files') {
        expect(readFileSync(join(f.path, 'notes'), 'utf8')).toBe('not the removed checkout')
      }
      if (leftover === 'unforced') {
        expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
      }
      expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({ instanceId: 'A' })
      return
    }
    await retry
    await settleRemovals()
    expect(existsSync(f.path)).toBe(false)
    expect(f.git('-C', f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.path)
    expect(branchExists(f)).toBe(false)
    expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toBeUndefined()
    // Other cases' failed records share the module's table; only this workspace's must be gone.
    expect(
      (await readWorktreeRemovalRecords(testState.dir)).filter((row) => row.worktreeId === f.id)
    ).toEqual([])
  }
)

it.each(['unregistered', 'registered', 'replaced'] as const)(
  'a resumed cleanup removal whose checkout is gone only does bookkeeping (%s)',
  async (state) => {
    const f = await fixture(false)
    const { expectedInstanceId, expectedCheckoutIdentity, ...rest } = await failedCleanupRecord(f)
    if (state === 'registered') {
      // Gone from disk while Git still lists it: bookkeeping prunes the stale registration.
      rmSync(f.path, { recursive: true, force: true })
    } else {
      f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
    }
    await writeWorktreeRemovalRecords(testState.dir, () => [
      { ...rest, expectedInstanceId, expectedCheckoutIdentity }
    ])
    const [persisted] = await readWorktreeRemovalRecords(testState.dir)
    if (!persisted) {
      throw new Error('Missing persisted removal')
    }
    const job = interruptedLocalWorktreeRemovalJob(persisted, {
      store: f.store,
      acquireWatcherRemoval: f.runtime.acquireFileWatcherRemoval,
      closeWatchers: async () => {},
      preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: () => {} },
      purge: () => f.store.removeWorktreeMeta(f.target),
      onRemoved: () => {},
      publish: () => {},
      // After the gone check and before bookkeeping: a folder appears at the path.
      stopPtys: async () => {
        if (state === 'replaced') {
          mkdirSync(f.path)
          writeFileSync(join(f.path, 'tracked'), 'B')
        }
      }
    })
    await loadWorktreeRemovalRecords(testState.dir)
    const pending = waitForPendingWorktreeRemoval(f.id)
    if (!pending) {
      throw new Error('Missing recovered removal')
    }
    resumeInterruptedWorktreeRemovals(() => job)
    if (state === 'replaced') {
      await expect(pending).rejects.toThrow()
      await settleRemovals()
      expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('B')
      expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({ instanceId: 'A' })
      return
    }
    await pending
    await settleRemovals()
    expect(existsSync(f.path)).toBe(false)
    expect(f.git('-C', f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.path)
    expect(branchExists(f)).toBe(false)
    expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toBeUndefined()
    // Other cases' failed records share the module's table; only this workspace's must be gone.
    expect(
      (await readWorktreeRemovalRecords(testState.dir)).filter((row) => row.worktreeId === f.id)
    ).toEqual([])
  }
)
