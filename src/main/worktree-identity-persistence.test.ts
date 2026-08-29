import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { canonicalWorktreeIdentity } from '../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { createStore, readDataFile, testState, writeDataFile } from './persistence-test-harness'

describe('host-qualified worktree metadata', () => {
  const worktreeId = 'repo-1::/workspace/feature'
  const ROTATED_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-identity-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stores independent metadata for colliding locators on two hosts', () => {
    const store = createStore()

    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })

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
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', {
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
    const store = createStore()
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })
    store.flush()

    const reloaded = createStore()
    expect(reloaded.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Local feature')
    expect(reloaded.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })
  it('keeps canonical metadata current for legacy writers on a known owner', () => {
    const store = createStore()
    store.setWorktreeMetaForHost(worktreeId, 'local', { comment: 'before' })

    store.setWorktreeMeta(worktreeId, { comment: 'after' })

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.comment).toBe('after')
  })
  it('backfills one stable instance for legacy metadata that omitted it', () => {
    const seed = createStore()
    seed.setWorktreeMeta(worktreeId, { displayName: 'Legacy feature' })
    seed.flush()
    const legacy = readDataFile() as PersistedState
    delete legacy.worktreeMeta[worktreeId]?.instanceId
    delete legacy.worktreeMetaByIdentity
    delete legacy.worktreeIdentityAliases
    writeDataFile(legacy)

    const store = createStore()
    const first = store.getWorktreeMetaForHost(worktreeId, 'local')
    const second = store.getWorktreeMetaForHost(worktreeId, 'local')
    store.setWorktreeMeta(worktreeId, { comment: 'after migration' })
    store.flush()

    expect(first?.instanceId).toBeTruthy()
    expect(second?.instanceId).toBe(first?.instanceId)
    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.comment).toBe('after migration')
    const migrated = readDataFile() as PersistedState
    expect(migrated.worktreeMeta[worktreeId]?.hostId).toBe('local')
    expect(Object.keys(migrated.worktreeMetaByIdentity ?? {})).toHaveLength(1)
  })
  // Fails open on purpose: an ambiguous alias used to brick reads and throw out of the worktree
  // listing loop, taking every workspace in the repo down with it and never self-healing.
  it('collapses an ambiguous locator onto its most recently active instance', () => {
    const seed = createStore()
    const first = seed.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'First' })
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
      store.setWorktreeMetaForHost(worktreeId, 'local', { comment: 'ambiguous write' })
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
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })

    store.removeWorktreeMeta(worktreeId, 'local')

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })

  it('removes only the selected host metadata when locators collide', () => {
    const store = createStore()
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })

    store.removeWorktreeMeta(worktreeId, 'ssh:build-box')

    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.displayName).toBe('Local feature')
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')).toBeUndefined()
    store.flush()
    expect(
      Object.keys((readDataFile() as PersistedState).worktreeMetaByIdentity ?? {})
    ).toHaveLength(1)
  })

  it('moves the locator alias without changing canonical identity', () => {
    const store = createStore()
    const meta = store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Feature' })
    const identityKey = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: 'local',
      instanceId: meta.instanceId!
    })
    const renamedId = 'repo-1::/workspace/renamed-feature'

    store.migrateWorktreeIdentity(worktreeId, renamedId)

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
    const meta = store.setWorktreeMetaForHost(worktreeId, 'local', {
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
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Feature' })

    // worktree-lineage-pruning rotates a proven-missing parent so path reuse cannot
    // validate old lineage; pinning the existing id silently disarmed that guard.
    const rotated = store.setWorktreeMeta(worktreeId, { instanceId: ROTATED_INSTANCE_ID })

    expect(rotated.instanceId).toBe(ROTATED_INSTANCE_ID)
    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.instanceId).toBe(ROTATED_INSTANCE_ID)
    store.flush()
    const persisted = readDataFile() as PersistedState
    // The old identity row goes with the rotation rather than lingering unreachable.
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
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })
    const renamedId = 'repo-1::/workspace/renamed-feature'

    store.migrateWorktreeIdentity(worktreeId, renamedId, 'local')

    expect(store.getWorktreeMetaForHost(renamedId, 'local')?.displayName).toBe('Local feature')
    // The SSH host never moved, so its row must stay reachable at the path it still has.
    expect(store.getWorktreeMetaForHost(worktreeId, 'ssh:build-box')?.displayName).toBe(
      'Remote feature'
    )
  })

  it('drops every host identity row when a locator is removed outright', () => {
    const store = createStore()
    store.setWorktreeMetaForHost(worktreeId, 'local', { displayName: 'Local feature' })
    store.setWorktreeMetaForHost(worktreeId, 'ssh:build-box', { displayName: 'Remote feature' })

    store.removeWorktreeMeta(worktreeId)

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.worktreeMetaByIdentity ?? {}).toEqual({})
    expect(persisted.worktreeIdentityAliases ?? {}).toEqual({})
  })

  it('repairs a missing canonical instance id while re-adopting an SSH target', () => {
    const oldHostId = 'ssh:old-target' as const
    const newHostId = 'ssh:new-target' as const
    const seed = createStore()
    seed.setWorktreeMetaForHost(worktreeId, oldHostId, { displayName: 'Remote feature' })
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
    store.setWorktreeMetaForHost(worktreeId, oldHostId, { displayName: 'Source feature' })
    store.setWorktreeMetaForHost(worktreeId, newHostId, {
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
    const seed = createStore()
    seed.setWorktreeMetaForHost(worktreeId, oldHostId, { displayName: 'Remote feature' })
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
