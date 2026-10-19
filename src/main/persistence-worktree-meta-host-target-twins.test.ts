import {
  closeTestStores,
  createStore as createFreshStore,
  testState
} from './persistence-test-harness'
/**
 * A local row and an SSH row can share a repo id, so they share every worktree id under it.
 * Worktree meta and lineage writes take the row's host (R4-2 family b), and a write for one
 * twin must never land on the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../shared/repo-types'
import type { WorktreeLineage } from '../shared/worktree/lineage-types'
import { getDefaultPersistedState } from '../shared/constants'
import { hostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import {
  removeWorktreeMetaRow,
  resolveWorktreeMetaOwner
} from './persistence/host-qualified-worktree-meta'
import { persistRuntimeManagedWorktreeSortOrder } from './runtime/runtime-managed-worktree-metadata'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

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
  it('writes each twin its own meta', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })

    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'local')?.displayName).toBe('local copy')
    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'ssh:ssh-1')?.displayName).toBe('ssh copy')
    expect(store.getWorktreeMeta(WORKTREE_ID)?.displayName).toBe('local copy')
  })

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

  it('removes an unhosted row only when nothing stamped it', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })

    expect(store.removeUnhostedWorktreeMeta(WORKTREE_ID)).toBe(false)
    expect(store.getWorktreeMeta(WORKTREE_ID)?.displayName).toBe('local copy')
  })

  it('a removal with no host takes the stamped owner, not every twin', async () => {
    const store = await createTwinStore()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })

    removeWorktreeMetaRow(store, WORKTREE_ID, undefined)

    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'ssh:ssh-1')?.displayName).toBe('ssh copy')
  })

  it('neither saves nor reports a sort order for an unstamped twin row', async () => {
    const store = await createTwinStore({
      worktreeMeta: { [WORKTREE_ID]: { displayName: 'legacy', sortOrder: 1 } }
    })
    const notifyChanged = vi.fn()

    const result = persistRuntimeManagedWorktreeSortOrder({
      orderedIds: [WORKTREE_ID],
      store,
      invalidateResolved: vi.fn(),
      notifyChanged
    })

    expect(result).toEqual({ updated: 0 })
    expect(notifyChanged).not.toHaveBeenCalled()
    expect(store.getWorktreeMeta(WORKTREE_ID)?.sortOrder).toBe(1)
  })

  it('refuses an id-only caller for twins, stamped or not', async () => {
    const store = await createTwinStore()
    expect(resolveWorktreeMetaOwner(store, WORKTREE_ID)).toBeUndefined()

    // The raw-id row's stamp names the twin that wrote first, not the one the caller means.
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })
    expect(resolveWorktreeMetaOwner(store, WORKTREE_ID)).toBeUndefined()
    store.setWorktreeMeta(LOCAL, { displayName: 'local copy' })
    expect(resolveWorktreeMetaOwner(store, WORKTREE_ID)).toBeUndefined()
  })

  it('resolves an id-only caller to the stamp when one host holds the repo', async () => {
    const store = await createTwinStore({ repos: [twinRepos[1]] })
    expect(resolveWorktreeMetaOwner(store, WORKTREE_ID)).toEqual(SSH)

    store.setWorktreeMeta(SSH, { displayName: 'ssh copy' })
    expect(resolveWorktreeMetaOwner(store, WORKTREE_ID)).toEqual(SSH)
  })

  it('an id-only sort order never lands on the twin that wrote first', async () => {
    const solo = hostWorktreeTarget({ id: 'solo::/a', hostId: 'local' })
    const store = await createTwinStore({
      repos: [...twinRepos, { ...twinRepos[0], id: 'solo', path: '/a' }]
    })
    store.setWorktreeMeta(SSH, { displayName: 'ssh copy', sortOrder: 10 })
    store.setWorktreeMeta(solo, { sortOrder: 5 })

    const result = persistRuntimeManagedWorktreeSortOrder({
      orderedIds: [solo.id, WORKTREE_ID],
      store,
      invalidateResolved: vi.fn(),
      notifyChanged: vi.fn()
    })

    expect(result).toEqual({ updated: 1 })
    expect(store.getWorktreeMetaForHost(WORKTREE_ID, 'ssh:ssh-1')?.sortOrder).toBe(10)
  })
})
