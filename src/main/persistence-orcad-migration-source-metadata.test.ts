import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import { canonicalWorktreeIdentity } from '../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { Store } from './persistence'
import { createStore, testState, readDataFile, writeDataFile } from './persistence-test-harness'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  setupSource,
  TARGET,
  commitDestination
} from './orcad-migration-source-cutover-test-fixture'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'
import { retireOrcadMigrationSourceCatalogDurably } from './ssh/orcad-migration-cutover-coordinator'
import {
  inspectOrcadSourceWorktreeMetadata,
  retireOrcadSourceWorktreeMetadata,
  assertOrcadSourceWorktreeMetadataRetired
} from './persistence/migrating-orcad-catalog/orcad-source-worktree-metadata'
import { createOrcadMigrationSourceScope } from './persistence/migrating-orcad-catalog/orcad-source-scope'
import { assertOrcadDestinationCanonicalMetadata } from './persistence/migrating-orcad-catalog/orcad-destination-worktree-metadata'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
let owner: string
const host = `ssh:${TARGET.id}` as const
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-source-metadata-'))
  const worktree = join(testState.dir, 'worktree')
  mkdirSync(worktree)
  owner = `repo-1::${worktree}`
})
afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

it.each([false, true])(
  'preserves source metadata through destination import and source reload (canonical-only=%s)',
  async (canonicalOnly) => {
    const { store } = setupSource()
    if (canonicalOnly) {
      store.addRepo({
        id: 'repo-1',
        path: join(testState.dir, 'worktree'),
        displayName: 'Local repository',
        badgeColor: '#737373',
        addedAt: 1,
        executionHostId: 'local'
      })
      store.setWorktreeMetaForHost(owner, 'local', {
        instanceId: 'local-instance',
        comment: 'local data'
      })
    }
    store.setWorktreeMetaForHost(owner, host, {
      instanceId: 'source-instance',
      comment: 'remote data 🐋',
      displayName: 'Investigation',
      isPinned: true,
      lastActivityAt: 123
    })
    await store.flushPendingOrThrowAsync()
    const source = createStore()
    const manifest = createOrcadMigrationManifest(source, TARGET, { migrationId: 'canonical' })
    expect(manifest.payload.dormantState?.worktreeMeta).toHaveLength(1)
    expect(manifest.payload.dormantState?.worktreeMeta[0]).toMatchObject({
      worktreeId: owner,
      meta: { instanceId: 'source-instance', comment: 'remote data 🐋', hostId: 'local' }
    })
    const destinationFile = join(testState.dir, 'destination.json')
    const destination = new Store({ dataFile: destinationFile })
    destination.stageOrcadMigrationCatalog(manifest)
    destination.commitStagedOrcadMigrationCatalog(manifest)
    await destination.flushPendingOrThrowAsync()
    const reopenedDestination = new Store({ dataFile: destinationFile })
    expect(reopenedDestination.getWorktreeMetaForHost(owner, 'local')).toMatchObject({
      instanceId: 'source-instance',
      comment: 'remote data 🐋',
      displayName: 'Investigation',
      isPinned: true
    })
    await reopenedDestination.flushPendingOrThrowAsync()
    commitDestination(source, manifest)
    await retireOrcadMigrationSourceCatalogDurably({
      store: source,
      migrationId: manifest.migrationId
    })
    expect(source.getWorktreeMetaForHost(owner, host)).toBeUndefined()
    const reopened = createStore()
    expect(reopened.getWorktreeMetaForHost(owner, host)).toBeUndefined()
    expect(reopened.getAllWorktreeMetaForHost(host)).toEqual({})
    if (canonicalOnly) {
      expect(reopened.getWorktreeMetaForHost(owner, 'local')).toMatchObject({
        comment: 'local data'
      })
    }
  }
)

it('detects canonical-only edits after manifest capture even when no source legacy row exists', () => {
  const { store } = setupSource()
  store.setWorktreeMetaForHost(owner, 'local', { instanceId: 'local', comment: 'local' })
  store.setWorktreeMetaForHost(owner, host, { instanceId: 'remote', comment: 'before' })
  const manifest = createOrcadMigrationManifest(store, TARGET)
  store.setWorktreeMetaForHost(owner, host, { comment: 'after' })
  expect(store.inspectOrcadMigrationSourceDependencies(manifest).totalCount).toBeGreaterThan(0)
  expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment')).toThrow(
    'dependencies_present'
  )
  expect(store.getWorktreeMetaForHost(owner, host)?.comment).toBe('after')
})

it.each(['ambiguous', 'divergent'] as const)(
  'refuses %s canonical evidence rather than discarding a representation',
  async (kind) => {
    const { store } = setupSource()
    store.setWorktreeMetaForHost(owner, host, { instanceId: 'first', comment: 'first data' })
    await store.flushPendingOrThrowAsync()
    const saved = readDataFile() as PersistedState
    const alias = composeWorktreeHostIdentity(host, owner)
    const key = saved.worktreeIdentityAliases![alias][0]
    if (kind === 'ambiguous') {
      const second = canonicalWorktreeIdentity({
        worktreeId: owner,
        executionHostId: host,
        instanceId: 'second'
      })
      saved.worktreeMetaByIdentity![second] = {
        ...saved.worktreeMetaByIdentity![key],
        instanceId: 'second',
        comment: 'second data'
      }
      saved.worktreeIdentityAliases![alias].push(second)
    } else {
      saved.worktreeMetaByIdentity![key] = {
        ...saved.worktreeMetaByIdentity![key],
        comment: 'canonical data'
      }
    }
    writeDataFile(saved)
    const restored = createStore()
    const manifest = createOrcadMigrationManifest(restored, TARGET)
    expect(restored.inspectOrcadMigrationSourceDependencies(manifest).totalCount).toBeGreaterThan(0)
    expect(() => restored.beginOrcadMigrationSourceCutover(manifest, 'environment')).toThrow(
      'dependencies_present'
    )
  }
)

it('prunes only removed source identities and preserves shared identities and unrelated orphans', () => {
  const { store } = setupSource()
  const meta = store.setWorktreeMetaForHost(owner, host, {
    instanceId: 'source',
    comment: 'preserve'
  })
  const manifest = createOrcadMigrationManifest(store, TARGET)
  const state = getDefaultPersistedState(testState.dir)
  const sourceKey = canonicalWorktreeIdentity({
    worktreeId: owner,
    executionHostId: host,
    instanceId: 'source'
  })
  const sourceAlias = composeWorktreeHostIdentity(host, owner)
  const otherAlias = composeWorktreeHostIdentity('ssh:other', owner)
  state.worktreeMeta[owner] = structuredClone(meta)
  state.worktreeMetaByIdentity = {
    [sourceKey]: structuredClone(meta),
    orphan: { ...meta, hostId: 'local' }
  }
  state.worktreeIdentityAliases = { [sourceAlias]: [sourceKey], [otherAlias]: [sourceKey] }
  retireOrcadSourceWorktreeMetadata(state, manifest)
  expect(state.worktreeIdentityAliases).toEqual({ [otherAlias]: [sourceKey] })
  expect(state.worktreeMetaByIdentity[sourceKey]).toEqual(meta)
  expect(state.worktreeMetaByIdentity.orphan).toBeDefined()
  expect(() => assertOrcadSourceWorktreeMetadataRetired(state, manifest)).not.toThrow()
  state.worktreeIdentityAliases[sourceAlias] = [sourceKey]
  expect(() => assertOrcadSourceWorktreeMetadataRetired(state, manifest)).toThrow(
    'metadata_reappeared'
  )
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  expect(inspectOrcadSourceWorktreeMetadata(state, scope).rows).toHaveLength(1)
})

it('refuses a destination canonical row that would shadow the imported legacy projection', () => {
  const { store } = setupSource()
  store.setWorktreeMetaForHost(owner, host, { instanceId: 'source', comment: 'source data' })
  const manifest = createOrcadMigrationManifest(store, TARGET)
  const destination = new Store({ dataFile: join(testState.dir, 'conflicting-destination.json') })
  destination.setWorktreeMetaForHost(owner, 'ssh:other', {
    instanceId: 'other',
    comment: 'other host'
  })
  destination.setWorktreeMetaForHost(owner, 'local', {
    instanceId: 'source',
    comment: 'destination data'
  })
  expect(() => destination.stageOrcadMigrationCatalog(manifest)).toThrow(
    'dormant_id_conflict:worktree_meta'
  )
  expect(destination.getWorktreeMetaForHost(owner, 'local')?.comment).toBe('destination data')
  expect(destination.getWorktreeMetaForHost(owner, 'ssh:other')?.comment).toBe('other host')
})

it('accepts exact destination canonical metadata but refuses competing alias candidates', () => {
  const { store } = setupSource()
  store.setWorktreeMetaForHost(owner, host, { instanceId: 'source', comment: 'source data' })
  const manifest = createOrcadMigrationManifest(store, TARGET)
  const entries = manifest.payload.dormantState!.worktreeMeta
  const state = getDefaultPersistedState(testState.dir)
  const alias = composeWorktreeHostIdentity('local', owner)
  const key = canonicalWorktreeIdentity({
    worktreeId: owner,
    executionHostId: 'local',
    instanceId: 'source'
  })
  state.worktreeMetaByIdentity = { [key]: structuredClone(entries[0].meta) }
  state.worktreeIdentityAliases = { [alias]: [key] }
  expect(() => assertOrcadDestinationCanonicalMetadata(state, entries)).not.toThrow()
  state.worktreeIdentityAliases[alias].push('other')
  expect(() => assertOrcadDestinationCanonicalMetadata(state, entries)).toThrow(
    'dormant_id_conflict:worktree_meta'
  )
})
