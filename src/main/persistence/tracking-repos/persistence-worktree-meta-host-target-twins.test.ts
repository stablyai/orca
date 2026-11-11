import {
  closeTestStores,
  createStore as createFreshStore,
  testState
} from '../persistence-test-harness'
// Identical repo/path IDs across hosts require host-scoped metadata and lineage writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { removeWorktreeMetaRow } from '../host-qualified-worktree-meta'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const WORKTREE_ID = 'dup::/wt'
const LOCAL = hostWorktreeTarget({ id: WORKTREE_ID, hostId: 'local' })
const SSH = hostWorktreeTarget({ id: WORKTREE_ID, hostId: 'ssh:ssh-1' })

const twinRepos: Repo[] = [
  { id: 'dup', path: '/wt', displayName: 'Local', badgeColor: '#000', addedAt: 1 },
  {
    id: 'dup',
    path: '/wt',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-1'
  }
]

function lineage(instanceId: string): WorktreeLineage {
  return {
    worktreeId: WORKTREE_ID,
    worktreeInstanceId: instanceId,
    parentWorktreeId: 'dup::/parent',
    parentWorktreeInstanceId: 'parent',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function createTwinStore(state: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), repos: twinRepos, ...state }),
    'utf-8'
  )
  return createFreshStore()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-meta-twins-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('worktree meta and lineage writes for same-id twins', () => {
  it('removes one twin without touching the other', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })
    store.setWorktreeLineage(LOCAL, lineage('local'))

    store.removeWorktreeMeta(SSH)

    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'ssh:ssh-1')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'local')?.displayName).toBe('local copy')
    expect(store.getWorktreeLineage(WORKTREE_ID)?.worktreeInstanceId).toBe('local')
  })

  it('keeps the owning twin lineage when the other twin writes or removes it', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeLineage(LOCAL, lineage('local'))
    store.setWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(WORKTREE_ID),
      childInstanceId: 'local',
      parentWorkspaceKey: worktreeWorkspaceKey('dup::/parent'),
      parentInstanceId: 'parent',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })

    expect(store.setWorktreeLineage(SSH, lineage('ssh'))).toBeUndefined()
    store.removeWorktreeLineage(SSH)

    expect(store.getWorktreeLineage(WORKTREE_ID)?.worktreeInstanceId).toBe('local')
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(WORKTREE_ID))).toBeDefined()

    store.removeWorktreeLineage(LOCAL)
    expect(store.getWorktreeLineage(WORKTREE_ID)).toBeUndefined()
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(WORKTREE_ID))).toBeUndefined()
  })

  it('renames only the named twin', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })

    store.migrateWorktreeIdentity(SSH, 'dup::/renamed')

    expect(store.getWorktreeMetaForHost('dup::/renamed', 'ssh:ssh-1')?.displayName).toBe('ssh copy')
    expect(store.getWorktreeMeta(WORKTREE_ID)?.displayName).toBe('local copy')
    expect(store.getWorktreeMetaForHost('dup::/renamed', 'local')).toBeUndefined()
  })

  it('a removal with no host takes the stamped owner, not every twin', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })

    removeWorktreeMetaRow(store, WORKTREE_ID, undefined)

    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'ssh:ssh-1')?.displayName).toBe('ssh copy')
  })
})
