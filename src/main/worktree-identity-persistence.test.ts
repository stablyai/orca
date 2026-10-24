import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { canonicalWorktreeIdentity } from '../shared/worktree/identity'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../shared/worktree/host-qualified-identity'
import type { Store } from './persistence/loading-store/store'
import {
  createStore,
  makeRepo,
  makeWorktreeLineage,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { getAllWorktreeMetaForHost } from './persistence/loading-store/worktree-identity-metadata'
import { mergeWorktreeMetaForWrite } from './persistence/loading-store/worktree-meta-write-normalization'
import { removeWorktreeMetaRow } from './persistence/host-qualified-worktree-meta'
import {
  projectWorktreeLineageWithHostPeers,
  withSavedWorktreeLineage
} from './worktree-lineage-host-peers'
import {
  createSshWorktreeMetaIndex,
  listDisconnectedSshWorktrees
} from './ipc/worktrees/listing/ssh-worktree-fallback'
import { buildDisconnectedDetectedWorktrees } from './ipc/worktrees/listing/folder-workspace-catalog'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import {
  getFolderWorkspaceRootId,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'

describe('host-qualified worktree metadata', () => {
  const worktreeId = 'repo-1::/workspace/feature'
  const ROTATED_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'

  // Register the repo so load-time orphan cleanup retains its metadata.
  const createStoreWithRepo = (): Store => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/workspace' }))
    return store
  }

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-identity-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reads the full-host alias winner without migration or writes', () => {
    const store = createStoreWithRepo()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      instanceId: 'local-instance'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:copy' }), {
      instanceId: 'copy-instance'
    })
    const written = vi.fn()
    const stop = store.onStateWritten(written)
    const raw = store.getAllWorktreeMeta()
    expect(store.getAllWorktreeMetaForHost('ssh:copy')[worktreeId]).toMatchObject({
      instanceId: 'copy-instance',
      hostId: 'ssh:copy'
    })
    expect(store.getAllWorktreeMeta()).toBe(raw)
    expect(written).not.toHaveBeenCalled()
    stop()
    const first = mergeWorktreeMetaForWrite(undefined, { lastActivityAt: 1 })
    const second = { ...first, displayName: 'winner', lastActivityAt: 2 }
    const state = {
      worktreeMeta: { [worktreeId]: first },
      worktreeIdentityAliases: { [composeWorktreeHostIdentity('local', worktreeId)]: ['a', 'b'] },
      worktreeMetaByIdentity: { a: first, b: second }
    }
    const before = JSON.stringify(state)
    expect(getAllWorktreeMetaForHost({ state }, 'local')[worktreeId]).toEqual({
      ...second,
      hostId: 'local'
    })
    expect(JSON.stringify(state)).toBe(before)
    state.worktreeMetaByIdentity.b = { ...second, hostId: 'ssh:wrong' }
    expect(getAllWorktreeMetaForHost({ state }, 'local')[worktreeId]).toBe(first)
  })

  it('retains workspace-only links and raw-owner SSH intent with one saved-edge attachment', () => {
    const store = createStoreWithRepo()
    const folder = makeRepo({ id: 'folder-repo', kind: 'folder', path: '/folder' })
    store.addRepo(folder)
    const folderId = getFolderWorkspaceRootId(folder)
    const raw = store.getAllWorktreeMeta()
    const workspaceRead = vi.spyOn(store, 'getWorkspaceLineage')
    const bulkWorkspaceRead = vi.spyOn(store, 'getAllWorkspaceLineage')
    for (const id of [worktreeId, folderId]) {
      const meta = store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
        instanceId: 'child-instance'
      })
      const edge: WorkspaceLineage = {
        childWorkspaceKey: worktreeWorkspaceKey(id),
        childInstanceId: meta.instanceId,
        parentWorkspaceKey: 'folder:missing-parent',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
      store.setWorkspaceLineage(edge)
      const owner = id === folderId ? folder : makeRepo({ id: 'repo-1', path: '/workspace' })
      const row =
        id === folderId
          ? mergeFolderWorkspace(folder, id, meta)
          : mergeWorktree(
              owner.id,
              {
                path: '/workspace/feature',
                head: '',
                branch: '',
                isBare: false,
                isMainWorktree: false
              },
              meta
            )
      const [published] = projectWorktreeLineageWithHostPeers(store, owner, [row], raw)
      expect(published).toMatchObject({
        parentWorktreeId: null,
        lineage: null,
        savedLineage: {
          ...edge,
          worktreeId: id,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: 'folder:missing-parent',
          parentWorktreeInstanceId: ''
        }
      })
    }
    expect(workspaceRead).not.toHaveBeenCalled()
    expect(bulkWorkspaceRead).toHaveBeenCalledTimes(2)

    for (const rawHost of ['local', 'ssh:copy'] as const) {
      const remoteStore = createStore()
      const remoteRepo = makeRepo({
        id: 'repo-1',
        path: '/workspace',
        connectionId: 'copy',
        executionHostId: 'ssh:copy'
      })
      remoteStore.addRepo(remoteRepo)
      const target = hostWorktreeTarget({ id: worktreeId, hostId: rawHost })
      remoteStore.setWorktreeMeta(target, { instanceId: 'copied-child' })
      remoteStore.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:copy' }), {
        instanceId: 'copied-child'
      })
      const edge: WorktreeLineage = {
        worktreeId,
        worktreeInstanceId: 'copied-child',
        parentWorktreeId: 'parent::/parent',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
      expect(remoteStore.setWorktreeLineage(target, edge)).toEqual(edge)
      const hostMeta = remoteStore.getAllWorktreeMetaForHost('ssh:copy')
      const index = createSshWorktreeMetaIndex(Object.entries(hostMeta))
      const rawRead = vi.spyOn(remoteStore, 'getWorktreeMeta')
      const bulkRawRead = vi.spyOn(remoteStore, 'getAllWorktreeMeta')
      const lineageRead = vi.spyOn(remoteStore, 'getAllWorktreeLineage')
      const rows = listDisconnectedSshWorktrees(remoteStore, remoteRepo, index, {
        attachSavedLineage: false
      })
      const published = buildDisconnectedDetectedWorktrees(remoteStore, remoteRepo, rows, {
        hostMeta
      })
      expect(published).toHaveLength(1)
      expect(published[0].savedLineage).toEqual(rawHost === 'local' ? null : edge)
      expect(rawRead).toHaveBeenCalledTimes(1)
      expect(lineageRead).toHaveBeenCalledTimes(1)
      expect(bulkRawRead).not.toHaveBeenCalled()
    }
  })

  it('omits genuinely absent saved edges without copying unprojected rows or consulting owners', () => {
    const store = createStoreWithRepo()
    const repo = store.getRepos()[0]
    const row = mergeWorktree(
      repo.id,
      {
        path: '/workspace/feature',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: false
      },
      undefined
    )
    const rows = [row]
    const ownerRead = vi.spyOn(store, 'getWorktreeMeta')
    const edgeRead = vi.spyOn(store, 'getAllWorktreeLineage')
    const workspaceRead = vi.spyOn(store, 'getAllWorkspaceLineage')
    const pointRead = vi.spyOn(store, 'getWorkspaceLineage')
    expect(withSavedWorktreeLineage(store, repo, rows)).toBe(rows)
    const [published] = projectWorktreeLineageWithHostPeers(store, repo, rows)
    expect(published).not.toHaveProperty('savedLineage')
    expect(published).toMatchObject({ lineage: null, parentWorktreeId: null, childWorktreeIds: [] })
    expect(ownerRead).not.toHaveBeenCalled()
    expect(pointRead).not.toHaveBeenCalled()
    expect(edgeRead).toHaveBeenCalledTimes(2)
    expect(workspaceRead).toHaveBeenCalledTimes(2)
    expect(
      projectWorktreeLineageWithHostPeers(store, repo, [{ ...row, savedLineage: null }])[0]
        .savedLineage
    ).toBeNull()
    const stale = { ...row, savedLineage: makeWorktreeLineage({ worktreeId: row.id }) }
    expect(withSavedWorktreeLineage(store, repo, [stale])[0].savedLineage).toBeNull()
    expect(projectWorktreeLineageWithHostPeers(store, repo, [stale])[0].savedLineage).toBeNull()
  })

  it('stores independent metadata for colliding locators on two hosts', () => {
    const store = createStore()

    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Local feature')
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(Object.keys(persisted.worktreeMetaByIdentity ?? {})).toHaveLength(2)
    expect(store.getWorktreeMeta(worktreeId)?.displayName).toBe('Local feature')
  })
  it('projects canonical-only metadata for exactly one host', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })

    expect(store.getAllWorktreeMetaForHost('local')).toEqual({
      [worktreeId]: expect.objectContaining({ displayName: 'Local feature', hostId: 'local' })
    })
    expect(store.getAllWorktreeMetaForHost('ssh:build-box')).toEqual({
      [worktreeId]: expect.objectContaining({
        displayName: 'Remote feature',
        hostId: 'ssh:build-box'
      })
    })
  })
  it('reloads host-specific metadata without collapsing it to the legacy locator', () => {
    const store = createStoreWithRepo()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })
    store.flush()

    const reloaded = createStore()
    expect(reloaded.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Local feature')
    expect(reloaded.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })
  it('keeps canonical metadata current for legacy writers on a known owner', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      comment: 'before'
    })

    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      comment: 'after'
    })

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.comment).toBe('after')
  })
  it('backfills one stable instance for legacy metadata that omitted it', () => {
    const seed = createStoreWithRepo()
    seed.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Legacy feature'
    })
    seed.flush()
    const legacy = readDataFile() as PersistedState
    delete legacy.worktreeMeta[worktreeId]?.instanceId
    delete legacy.worktreeMetaByIdentity
    delete legacy.worktreeIdentityAliases
    writeDataFile(legacy)

    const store = createStore()
    const first = store.getWorktreeMetaForHost(worktreeId, 'local')
    const second = store.getWorktreeMetaForHost(worktreeId, 'local')
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      comment: 'after migration'
    })
    store.flush()

    expect(first?.instanceId).toBeTruthy()
    expect(second?.instanceId).toBe(first?.instanceId)
    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.comment).toBe('after migration')
    const migrated = readDataFile() as PersistedState
    expect(migrated.worktreeMeta[worktreeId]?.hostId).toBe('local')
    expect(Object.keys(migrated.worktreeMetaByIdentity ?? {})).toHaveLength(1)
  })
  it('collapses an ambiguous locator onto its most recently active instance', () => {
    const seed = createStoreWithRepo()
    const first = seed.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'First'
    })
    seed.flush()
    const persisted = readDataFile() as PersistedState
    const alias = composeWorktreeHostIdentity('local', worktreeId)
    const secondKey = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: 'local',
      instanceId: '33333333-3333-4333-8333-333333333333'
    })
    persisted.worktreeMetaByIdentity ??= {}
    persisted.worktreeIdentityAliases ??= {}
    persisted.worktreeMetaByIdentity[secondKey] = {
      ...first,
      instanceId: '33333333-3333-4333-8333-333333333333',
      displayName: 'Second',
      lastActivityAt: 1
    }
    persisted.worktreeIdentityAliases[alias] = [
      ...(persisted.worktreeIdentityAliases[alias] ?? []),
      secondKey
    ]
    writeDataFile(persisted)

    const store = createStore()
    expect(() =>
      store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
        comment: 'ambiguous write'
      })
    ).toThrow('Worktree identity is ambiguous for this host and locator.')

    const repaired = createStore()
    expect(repaired.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Second')
    repaired.flush()
    const afterRead = readDataFile() as PersistedState
    expect(afterRead.worktreeIdentityAliases?.[alias]).toEqual([
      persisted.worktreeIdentityAliases?.[alias]?.[0],
      secondKey
    ])
    expect(Object.keys(afterRead.worktreeMetaByIdentity ?? {})).toHaveLength(2)
  })

  it('removes only the selected legacy-owner metadata when locators collide', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }))

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })

  it('removes only the selected host metadata when locators collide', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }))

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Local feature')
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')).toBeUndefined()
    store.flush()
    expect(
      Object.keys((readDataFile() as PersistedState).worktreeMetaByIdentity ?? {})
    ).toHaveLength(1)
  })

  it('moves the locator alias without changing canonical identity', () => {
    const store = createStore()
    const meta = store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Feature'
    })
    const identityKey = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: 'local',
      instanceId: meta.instanceId!
    })
    const renamedId = 'repo-1::/workspace/renamed-feature'

    store.migrateWorktreeIdentity(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' }),
      renamedId
    )

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(renamedId, 'local')?.instanceId).toBe(meta.instanceId)
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.worktreeMetaByIdentity?.[identityKey]?.displayName).toBe('Feature')
    expect(
      persisted.worktreeIdentityAliases?.[composeWorktreeHostIdentity('local', renamedId)]
    ).toEqual([identityKey])
  })

  it('keeps the canonical identity stable when the locator changes', () => {
    const store = createStore()
    const meta = store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Feature'
    })

    const before = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: 'local',
      instanceId: meta.instanceId!
    })
    const after = canonicalWorktreeIdentity({
      worktreeId: 'repo-1::/workspace/renamed-feature',
      executionHostId: 'local',
      instanceId: meta.instanceId!
    })

    expect(after).toBe(before)
    expect(composeWorktreeHostIdentity('local', worktreeId)).toBe(
      'local|repo-1::/workspace/feature'
    )
  })
  it('honours a deliberate instanceId rotation instead of pinning the stored one', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Feature'
    })

    // A proven-missing parent rotates its identity so path reuse cannot validate old lineage.
    const rotated = store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      instanceId: ROTATED_INSTANCE_ID
    })

    expect(rotated.instanceId).toBe(ROTATED_INSTANCE_ID)
    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.instanceId).toBe(ROTATED_INSTANCE_ID)
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(Object.keys(persisted.worktreeMetaByIdentity ?? {})).toEqual([
      canonicalWorktreeIdentity({
        worktreeId,
        executionHostId: 'local',
        instanceId: ROTATED_INSTANCE_ID
      })
    ])
  })

  it('leaves other hosts at the old locator when one host renames its folder', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })
    const renamedId = 'repo-1::/workspace/renamed-feature'

    store.migrateWorktreeIdentity(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' }),
      renamedId
    )

    expect(store.getWorktreeMetaForHost(renamedId, 'local')?.displayName).toBe('Local feature')
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })

  it('drops every host identity row once each host removes its copy', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      displayName: 'Local feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }), {
      displayName: 'Remote feature'
    })

    expect(store.removeUnhostedWorktreeMeta(worktreeId)).toBe(false)
    removeWorktreeMetaRow(store, worktreeId, undefined)
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:build-box' }))

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.worktreeMetaByIdentity ?? {}).toEqual({})
    expect(persisted.worktreeIdentityAliases ?? {}).toEqual({})
  })

  it('repairs a missing canonical instance id while re-adopting an SSH target', () => {
    const oldHostId = 'ssh:old-target' as const
    const newHostId = 'ssh:new-target' as const
    const seed = createStoreWithRepo()
    seed.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: oldHostId }), {
      displayName: 'Remote feature'
    })
    seed.flush()
    const persisted = readDataFile() as PersistedState
    const oldAlias = composeWorktreeHostIdentity(oldHostId, worktreeId)
    const oldKey = persisted.worktreeIdentityAliases?.[oldAlias]?.[0]
    expect(oldKey).toBeTruthy()
    delete persisted.worktreeMetaByIdentity?.[oldKey!]?.instanceId
    writeDataFile(persisted)

    const store = createStore()
    store.reassignSshTargetId('old-target', 'new-target')
    store.flush()

    const repaired = readDataFile() as PersistedState
    const newAlias = composeWorktreeHostIdentity(newHostId, worktreeId)
    const newKey = repaired.worktreeIdentityAliases?.[newAlias]?.[0]
    expect(repaired.worktreeIdentityAliases?.[oldAlias]).toBeUndefined()
    expect(newKey).toBeTruthy()
    expect(repaired.worktreeMetaByIdentity?.[newKey!]).toMatchObject({
      displayName: 'Remote feature',
      hostId: newHostId,
      instanceId: expect.any(String)
    })
    expect(repaired.worktreeMetaByIdentity?.[oldKey!]).toBeUndefined()
  })

  it('preserves source metadata when the re-adoption destination is divergent', () => {
    const oldHostId = 'ssh:old-target' as const
    const newHostId = 'ssh:new-target' as const
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: oldHostId }), {
      displayName: 'Source feature'
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: newHostId }), {
      displayName: 'Destination feature'
    })

    store.reassignSshTargetId('old-target', 'new-target')

    expect(store.getWorktreeMetaForHost(worktreeId, oldHostId)?.displayName).toBe('Source feature')
    expect(store.getWorktreeMetaForHost(worktreeId, newHostId)?.displayName).toBe(
      'Destination feature'
    )
    expect(store.getWorktreeMeta(worktreeId)?.hostId).toBe(oldHostId)
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(
      persisted.worktreeIdentityAliases?.[composeWorktreeHostIdentity(oldHostId, worktreeId)]
    ).toHaveLength(1)
    expect(
      persisted.worktreeIdentityAliases?.[composeWorktreeHostIdentity(newHostId, worktreeId)]
    ).toHaveLength(1)
  })

  it('deduplicates an equivalent destination during SSH target re-adoption', () => {
    const oldHostId = 'ssh:old-target' as const
    const newHostId = 'ssh:new-target' as const
    const seed = createStoreWithRepo()
    seed.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: oldHostId }), {
      displayName: 'Remote feature'
    })
    seed.flush()
    const persisted = readDataFile() as PersistedState
    const oldAlias = composeWorktreeHostIdentity(oldHostId, worktreeId)
    const oldKey = persisted.worktreeIdentityAliases?.[oldAlias]?.[0]
    const source = oldKey ? persisted.worktreeMetaByIdentity?.[oldKey] : undefined
    expect(source?.instanceId).toBeTruthy()
    const newAlias = composeWorktreeHostIdentity(newHostId, worktreeId)
    const newKey = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: newHostId,
      instanceId: source!.instanceId!
    })
    persisted.worktreeMetaByIdentity ??= {}
    persisted.worktreeIdentityAliases ??= {}
    persisted.worktreeMetaByIdentity[newKey] = { ...source!, hostId: newHostId }
    persisted.worktreeIdentityAliases[newAlias] = [newKey]
    writeDataFile(persisted)

    const store = createStore()
    store.reassignSshTargetId('old-target', 'new-target')
    store.flush()

    const deduped = readDataFile() as PersistedState
    expect(deduped.worktreeIdentityAliases?.[oldAlias]).toBeUndefined()
    expect(deduped.worktreeIdentityAliases?.[newAlias]).toEqual([newKey])
    expect(deduped.worktreeMetaByIdentity?.[oldKey!]).toBeUndefined()
    expect(deduped.worktreeMetaByIdentity?.[newKey]).toEqual({ ...source!, hostId: newHostId })
  })
})
