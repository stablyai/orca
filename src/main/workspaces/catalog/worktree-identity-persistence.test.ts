import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import '../../../shared/worktree/identity'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import type { Store } from '../../persistence/loading-store/store'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  testState,
  writeDataFile
} from '../../persistence/persistence-test-harness'
import { removeWorktreeMetaRow } from '../../persistence/host-qualified-worktree-meta'

describe('host-qualified worktree metadata', () => {
  const worktreeId = 'repo-1::/workspace/feature'

  // Register the repo so load-time orphan cleanup retains its metadata.
  const createStoreWithRepo = (): Store => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/workspace' }))
    return store
  }

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-identity-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
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
})
