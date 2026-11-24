import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState
} from '../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { WorkspaceLifecycleQueue } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-queue'
import { queueWorkspaceDelete } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import { pinWorkspacesForCleanup } from './workspace-cleanup-pin'
import { admitWorkspaceCleanup } from './workspace-cleanup-admission'
import { WorktreeRemovalIdentityUnverifiableError } from '../../../shared/worktree/removal/worktree-checkout-identity'
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-cleanup-admission-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
function fixture(withQueue = true) {
  const store = createStore()
  const repo = {
    id: 'repo',
    path: testState.dir,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  const rows = ['a', 'b'].map((instanceId) => ({
    worktreeId: `repo::${join(testState.dir, instanceId)}`,
    instanceId
  }))
  for (const row of rows) {
    store.setWorktreeMeta(hostWorktreeTarget({ id: row.worktreeId, hostId: 'local' }), {
      instanceId: row.instanceId,
      isPinned: false
    })
  }
  const runtime = {
    workspaceLifecycle: withQueue ? new WorkspaceLifecycleQueue() : null,
    requireStore: () => store,
    listRepos: () => [repo],
    showManagedWorktree: async () => ({ id: rows[0].worktreeId, repoId: 'repo' }),
    listTerminals: async () => ({ terminals: [], truncated: false }),
    getWorktreePs: async () => ({
      truncated: false,
      worktrees: rows.map((row) => ({
        ...row,
        hostId: 'local' as const,
        worktreeInstanceId: row.instanceId
      }))
    })
  }
  return { store, rows, runtime }
}
// Both win orders run with the lifecycle queue off, where only the durable writer orders Keep and admission.
it('keeps both durable incarnations before automatic admission', async () => {
  const { store, rows, runtime } = fixture(false)
  const inventory = Promise.withResolvers<void>()
  const discovered = Promise.withResolvers<void>()
  const normal = runtime.getWorktreePs
  runtime.getWorktreePs = async () => {
    discovered.resolve()
    await inventory.promise
    return normal()
  }
  const keep = pinWorkspacesForCleanup(runtime, rows)
  await discovered.promise
  inventory.resolve()
  expect(await keep).toEqual({
    pinned: rows.map((row) => row.worktreeId),
    deleted: [],
    failed: [],
    tooLate: []
  })
  const removed: string[] = []
  for (const row of rows) {
    const admission = await admitWorkspaceCleanup(
      store,
      {
        ...row,
        repoId: 'repo',
        repoName: 'Fixture',
        displayName: row.instanceId,
        path: join(testState.dir, row.instanceId),
        branch: row.instanceId
      },
      () =>
        queueWorkspaceDelete(runtime, `id:${row.worktreeId}`, 'local', {}, async () => {
          removed.push(row.instanceId)
        })
    )
    expect(admission).toEqual({ admitted: false, cause: 'pinned' })
  }
  expect(removed).toEqual([])
  expect(
    Object.values(readPersistedState().worktreeMeta)
      .filter((row) => row.isPinned)
      .map((row) => row.instanceId)
      .sort()
  ).toEqual(['a', 'b'])
})
it('refuses a late Keep after automatic admission', async () => {
  const { store, rows, runtime } = fixture(false)
  const finish = Promise.withResolvers<void>()
  const row = rows[0]
  const admission = await admitWorkspaceCleanup(
    store,
    {
      ...row,
      repoId: 'repo',
      repoName: 'Fixture',
      displayName: 'a',
      path: join(testState.dir, 'a'),
      branch: 'a'
    },
    () => queueWorkspaceDelete(runtime, `id:${row.worktreeId}`, 'local', {}, () => finish.promise)
  )
  expect(admission.admitted).toBe(true)
  expect(await pinWorkspacesForCleanup(runtime, [row])).toEqual({
    pinned: [],
    deleted: [],
    failed: [],
    tooLate: [row.worktreeId]
  })
  finish.resolve()
  if (admission.admitted) {
    await admission.completion
  }
  expect(store.getWorktreeMetaForHost(row.worktreeId, 'local')?.isPinned).toBe(false)
})
it('persists successful batch pins without claiming a failed row was kept', async () => {
  const { store, rows, runtime } = fixture()
  const normal = store.setWorktreeMeta.bind(store)
  vi.spyOn(store, 'setWorktreeMeta').mockImplementation((target, updates) => {
    if (target.id === rows[1].worktreeId) {
      throw new Error('Fixture write failure')
    }
    return normal(target, updates)
  })
  expect(await pinWorkspacesForCleanup(runtime, rows)).toEqual({
    pinned: [rows[0].worktreeId],
    deleted: [],
    failed: [rows[1].worktreeId],
    tooLate: []
  })
  const persisted = Object.values(readPersistedState().worktreeMeta)
  expect(persisted.find((row) => row.instanceId === 'a')?.isPinned).toBe(true)
  expect(persisted.find((row) => row.instanceId === 'b')?.isPinned ?? false).toBe(false)
})
it('releases the admission when the removal route refused to delete an unverifiable checkout', async () => {
  const { store, rows } = fixture(false)
  const ref = {
    ...rows[0],
    repoId: 'repo',
    repoName: 'Fixture',
    displayName: 'a',
    path: join(testState.dir, 'a'),
    branch: 'a'
  }
  const refused = await admitWorkspaceCleanup(store, ref, async () => {
    throw new WorktreeRemovalIdentityUnverifiableError()
  })
  expect(refused.admitted).toBe(true)
  await expect(refused.admitted && refused.completion).rejects.toMatchObject({
    code: 'ERR_ORCA_WORKTREE_IDENTITY_UNVERIFIABLE'
  })
  // A later run may try the same, unchanged workspace again instead of reading it as still removing.
  const again = await admitWorkspaceCleanup(store, ref, async () => 'removed')
  expect(again.admitted).toBe(true)
  expect(again.admitted && (await again.completion)).toBe('removed')
})
