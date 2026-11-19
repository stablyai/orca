import { spawnProcessOnWorkerThread } from '../../worker-thread-child-process/worker-thread-child-process'
import { captureWorktreeCheckoutIdentity } from '../removal/worktree-checkout-identity'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { _resetWorktreeCatalogOwnerForTests } from '../catalog/repo-worktree-catalog-owner'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
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
afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  await closeTestStores()
  _resetWorktreeCatalogOwnerForTests()
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
it.each([true, false])(
  'leaves a real replacement at the removal boundary intact (queue=%s)',
  async (queued) => {
    const f = await fixture(queued)
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
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const acquire = f.runtime.acquireFileWatcherRemoval
    vi.spyOn(f.runtime, 'acquireFileWatcherRemoval').mockImplementation(async (...args) => {
      reached.resolve()
      await release.promise
      return acquire(...args)
    })
    const removal = removeWorkspaceForCleanup({
      store: f.store,
      runtime: f.runtime,
      workspace,
      globalRules: () => f.rules,
      now: Date.now
    })
    try {
      await Promise.race([
        reached.promise,
        removal.then((outcome) => {
          throw new Error(`Removal did not reach the boundary: ${JSON.stringify(outcome)}`)
        })
      ])
      f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
      f.git('-C', f.root, 'worktree', 'add', f.path, 'topic')
      f.store.removeWorktreeMeta(f.target)
      f.store.setWorktreeMeta(f.target, {
        instanceId: 'B',
        createdAt: old,
        lastActivityAt: old,
        isPinned: false
      })
      await f.runtime.getWorktreePs(100_000, true, false, undefined, undefined, true)
      const keep = await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'B' }])
      expect(keep).toEqual(
        queued
          ? { pinned: [], deleted: [], failed: [], tooLate: [f.id] }
          : { pinned: [f.id], deleted: [], failed: [], tooLate: [] }
      )
    } finally {
      release.resolve()
    }
    expect(await removal).toMatchObject({ outcome: 'failed' })
    expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
    expect(f.git('-C', f.path, 'status', '--porcelain')).toBe('')
    expect(
      await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'B' }])
    ).toEqual({ pinned: [f.id], deleted: [], failed: [], tooLate: [] })
    expect(
      Object.values(readPersistedState().worktreeMeta).find((row) => row.instanceId === 'B')
        ?.isPinned
    ).toBe(true)
  }
)
it.each([true, false])(
  'refuses a persisted deletion of A after a real replacement (metadata=%s)',
  async (rotateMetadata) => {
    const f = await fixture(false)
    const checkoutIdentity = await captureWorktreeCheckoutIdentity(f.path, 'A', f.root)
    const head = f.git('-C', f.path, 'rev-parse', 'HEAD')
    f.git('-C', f.root, 'worktree', 'remove', '--force', f.path)
    f.git('-C', f.root, 'worktree', 'add', f.path, 'topic')
    if (rotateMetadata) {
      f.store.removeWorktreeMeta(f.target)
      f.store.setWorktreeMeta(f.target, { instanceId: 'B', isPinned: true })
    }
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
    await _settlePendingWorktreeRemovalsForTests()
    expect(await readWorktreeRemovalRecords(testState.dir)).toEqual([])
    expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
    expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({
      instanceId: rotateMetadata ? 'B' : 'A',
      isPinned: rotateMetadata
    })
  }
)
it.each([true, false])(
  'retires a proven Git preflight refusal before Keep or another cleanup (queue=%s)',
  async (queued) => {
    const f = await fixture(queued)
    writeFileSync(join(f.path, 'tracked'), 'unsaved fixture edit')
    const attempt = await f.admit()
    if (!attempt.admitted) {
      throw new Error('Expected admission')
    }
    await expect(attempt.completion).rejects.toBeInstanceOf(WorktreeRemovalNotStartedError)
    expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('unsaved fixture edit')
    expect(
      await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'A' }])
    ).toEqual({ pinned: [f.id], deleted: [], failed: [], tooLate: [] })
    expect(
      Object.values(readPersistedState().worktreeMeta).find((row) => row.instanceId === 'A')
        ?.isPinned
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
  }
)
it.each([
  { queued: true, partial: false },
  { queued: false, partial: false },
  { queued: true, partial: true },
  { queued: false, partial: true }
])(
  'retains removal fences after settlement (queue=$queued, partial=$partial)',
  async ({ queued, partial }) => {
    const f = await fixture(queued)
    const original = gitExec.gitExecFileAsync
    const injection = vi
      .spyOn(gitExec, 'gitExecFileAsync')
      .mockImplementation(async (args, options) => {
        if (args.includes('worktree') && args.includes('remove')) {
          if (partial) {
            rmSync(join(f.path, 'tracked'))
          } else {
            writeFileSync(join(f.path, 'late-edit'), 'late unpublished fixture work')
          }
        }
        return original(args, options)
      })
    try {
      const attempt = await f.admit()
      if (!attempt.admitted) {
        throw new Error('Expected admission')
      }
      await expect(attempt.completion).rejects.not.toBeInstanceOf(WorktreeRemovalNotStartedError)
      expect(existsSync(join(f.path, 'tracked'))).toBe(!partial)
      expect(
        await pinWorkspacesForCleanup(f.runtime, [{ worktreeId: f.id, instanceId: 'A' }])
      ).toEqual({ pinned: [], deleted: [], failed: [], tooLate: [f.id] })
      expect(await f.admit()).toEqual({ admitted: false, cause: 'removing' })
    } finally {
      injection.mockRestore()
    }
  }
)

it.each([
  { queued: true, rotateMetadata: true },
  { queued: false, rotateMetadata: true },
  { queued: true, rotateMetadata: false },
  { queued: false, rotateMetadata: false }
])(
  'refuses a real replacement after worker dispatch and before spawn (queue=$queued, metadata=$rotateMetadata)',
  async ({ queued, rotateMetadata }) => {
    const f = await fixture(queued)
    const [workspace] = await collectWorkspaceCleanupWorkspaces({
      store: f.store,
      runtime: f.runtime,
      globalRules: f.rules,
      now: Date.now()
    })
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
      if (rotateMetadata) {
        f.store.removeWorktreeMeta(f.target)
        f.store.setWorktreeMeta(f.target, { instanceId: 'B', isPinned: true })
      }
    } finally {
      worker.releaseRemoval()
    }
    expect(await removal).toMatchObject({ outcome: 'failed' })
    expect(existsSync(f.path)).toBe(true)
    expect(readFileSync(join(f.path, 'tracked'), 'utf8')).toBe('seed')
    expect(f.store.getWorktreeMetaForHost(f.id, 'local')).toMatchObject({
      instanceId: rotateMetadata ? 'B' : 'A',
      isPinned: rotateMetadata
    })
  }
)

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
