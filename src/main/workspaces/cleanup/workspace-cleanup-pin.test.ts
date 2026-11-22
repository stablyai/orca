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
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { pinWorkspaceForCleanup } from './workspace-cleanup-pin'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-cleanup-pin-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})
function fixture() {
  const store = createStore()
  store.addRepo({
    id: 'repo',
    path: testState.dir,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  })
  const id = `repo::${testState.dir}/worktree`
  const target = hostWorktreeTarget({ id, hostId: 'local' })
  store.setWorktreeMeta(target, { instanceId: 'original', isPinned: false })
  return { store, id, target }
}
it('acknowledges Keep only after the same incarnation is pinned in SQLite', async () => {
  const { store, id } = fixture()
  await pinWorkspaceForCleanup(
    {
      requireStore: () => store,
      getWorktreePs: async () => ({
        truncated: false,
        worktrees: [{ worktreeId: id, hostId: 'local', worktreeInstanceId: 'original' }]
      })
    },
    id,
    'original'
  )
  expect(readWorktreeMetaForHost(store, id, 'local')).toMatchObject({
    instanceId: 'original',
    isPinned: true
  })
  expect(Object.values(readPersistedState().worktreeMeta)).toContainEqual(
    expect.objectContaining({ instanceId: 'original', isPinned: true })
  )
})
it('refuses Keep if a locator is reused between discovery and the durable mutation', async () => {
  const { store, id, target } = fixture()
  await expect(
    pinWorkspaceForCleanup(
      {
        requireStore: () => store,
        getWorktreePs: async () => {
          store.setWorktreeMeta(target, { instanceId: 'replacement', isPinned: false })
          return {
            truncated: false,
            worktrees: [{ worktreeId: id, hostId: 'local', worktreeInstanceId: 'original' }]
          }
        }
      },
      id,
      'original'
    )
  ).rejects.toThrow('workspace_cleanup_kept_workspace_deleted')
  expect(readWorktreeMetaForHost(store, id, 'local')).toMatchObject({
    instanceId: 'replacement',
    isPinned: false
  })
  await store.runDurableMutation(() => {
    store.updateSettings({ machineName: 'Writer remains usable' })
    return { value: true }
  })
  expect(readPersistedState().settings.machineName).toBe('Writer remains usable')
})
