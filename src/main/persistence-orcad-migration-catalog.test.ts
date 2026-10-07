import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ORCAD_MIGRATION_STAGED_CATALOGS } from '../shared/orcad-migration-manifest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { MAX_RETIREMENT_NAMESPACES } from './worktree-retirement-namespace'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN,
  DORMANT_LEAF_ID,
  DORMANT_NAMESPACE,
  DORMANT_WORKTREE_ID,
  FOLDER_WORKSPACE,
  REPOSITORY,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'
import {
  createStore,
  makeRepo,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 1 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

/** Stage then commit: the only path a destination publishes a catalog through. */
function commitCatalog(
  store: ReturnType<typeof createStore>,
  input: ReturnType<typeof manifest>,
  options?: { now?: () => Date }
) {
  store.stageOrcadMigrationCatalog(input, options)
  return store.commitStagedOrcadMigrationCatalog(input, options)
}

describe('orcad migration catalog persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-catalog-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('commits the catalog durably, strips source ownership, and replays idempotently', async () => {
    const store = createStore()
    const input = manifest()

    const first = commitCatalog(store, input, {
      now: () => new Date('2026-08-30T12:05:00.000Z')
    })
    await store.flushPendingOrThrowAsync()
    const restored = createStore()
    const replay = commitCatalog(restored, input)

    expect(first).toMatchObject({
      state: 'committed',
      receipt: {
        migrationId: 'migration-1',
        importedAt: '2026-08-30T12:05:00.000Z',
        repositoryIds: ['repo-1'],
        projectGroupIds: ['group-1'],
        folderWorkspaceIds: ['folder-1']
      }
    })
    expect(replay).toEqual(first)
    expect(restored.getRepos()).toEqual([
      expect.not.objectContaining({
        connectionId: expect.anything(),
        executionHostId: expect.anything()
      })
    ])
    expect(restored.getProjectGroups()).toEqual([
      expect.not.objectContaining({
        connectionId: expect.anything(),
        executionHostId: expect.anything()
      })
    ])
    expect(restored.getFolderWorkspaces()).toEqual([
      expect.objectContaining({ id: 'folder-1', comment: 'Keep this note' })
    ])
    expect(restored.getFolderWorkspaces()[0]?.connectionId).toBeNull()
    expect(restored.getFolderWorkspaces()[0]).not.toHaveProperty('executionHostId')
  })

  it('imports dormant source focus scalars alongside the inactive session', () => {
    const store = createStore()
    const incomingDormant = dormantState()
    incomingDormant.workspaceSession = {
      ...incomingDormant.workspaceSession!,
      activeRepoId: REPOSITORY.id,
      activeWorktreeId: DORMANT_WORKTREE_ID,
      activeWorkspaceKey: worktreeWorkspaceKey(DORMANT_WORKTREE_ID),
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'tab-dormant'
    }
    const base = manifest()
    const input = manifest({
      payload: { ...base.payload, dormantState: incomingDormant }
    })

    commitCatalog(store, input)

    expect(store.getWorkspaceSession()).toMatchObject({
      activeRepoId: REPOSITORY.id,
      activeWorktreeId: DORMANT_WORKTREE_ID,
      activeWorkspaceKey: worktreeWorkspaceKey(DORMANT_WORKTREE_ID),
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'tab-dormant'
    })
  })

  it('stages durably without publishing rows, then commits catalog and receipt together', async () => {
    const store = createStore()
    const input = manifest()

    expect(
      store.stageOrcadMigrationCatalog(input, {
        now: () => new Date('2026-08-30T12:03:00.000Z')
      })
    ).toEqual({
      state: 'staged',
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      stagedAt: '2026-08-30T12:03:00.000Z'
    })
    expect(store.getRepos()).toEqual([])
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'staged' })
    expect(
      restored.commitStagedOrcadMigrationCatalog(input, {
        now: () => new Date('2026-08-30T12:05:00.000Z')
      })
    ).toMatchObject({ state: 'committed', receipt: { importedAt: '2026-08-30T12:05:00.000Z' } })
    expect(restored.getRepos()).toHaveLength(1)
    await restored.flushPendingOrThrowAsync()

    const committed = createStore()
    expect(committed.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'committed',
      receipt: { repositoryIds: ['repo-1'] }
    })
    expect(readDataFile()).not.toHaveProperty('orcadMigrationStagedCatalogs.0')
  })

  it('commits dormant metadata, lineage, presets, and retirement state with the receipt', async () => {
    const store = createStore()
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    store.mergeRetiredWorktreeNamesForNamespace(DORMANT_NAMESPACE, ['octopus'])

    store.stageOrcadMigrationCatalog(input)
    expect(store.getAllWorktreeMeta()).toEqual({})
    expect(store.getSparsePresets(REPOSITORY.id)).toEqual([])

    store.commitStagedOrcadMigrationCatalog(input)
    expect(store.getWorktreeMeta(DORMANT_WORKTREE_ID)).toMatchObject({
      comment: 'Preserve me',
      hostId: 'local'
    })
    expect(store.getWorktreeLineage(DORMANT_WORKTREE_ID)?.parentWorktreeId).toBe(REPOSITORY.id)
    expect(
      store.getWorkspaceLineage(worktreeWorkspaceKey(DORMANT_WORKTREE_ID))?.parentWorkspaceKey
    ).toBe(folderWorkspaceKey(FOLDER_WORKSPACE.id))
    expect(store.getSparsePresets(REPOSITORY.id).map((preset) => preset.id)).toEqual(['preset-1'])
    expect(store.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]?.[0]).toMatchObject({
      id: 'tab-dormant',
      ptyId: null
    })
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-dormant']?.titlesByLeafId
    ).toEqual({ [DORMANT_LEAF_ID]: 'Investigating' })
    expect(store.listAutomations()).toEqual([
      expect.objectContaining({
        id: DORMANT_AUTOMATION.id,
        enabled: false,
        schedulerOwner: 'remote_host_service'
      })
    ])
    expect(store.listAutomationRuns(DORMANT_AUTOMATION.id)).toEqual([
      expect.objectContaining({
        id: DORMANT_AUTOMATION_RUN.id,
        outputSnapshot: expect.objectContaining({ content: 'all green' })
      })
    ])
    expect(store.getRetiredWorktreeNameRegistry(REPOSITORY.id).names).toContain('nautilus')
    expect(store.getRetiredWorktreeNameRegistryForNamespace(DORMANT_NAMESPACE).names).toEqual(
      expect.arrayContaining(['octopus', 'seahorse'])
    )
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'committed' })
    expect(restored.commitStagedOrcadMigrationCatalog(input)).toMatchObject({ state: 'committed' })
    expect(restored.getWorktreeMeta(DORMANT_WORKTREE_ID)?.comment).toBe('Preserve me')
    expect(restored.getSparsePresets(REPOSITORY.id)).toHaveLength(1)
    expect(restored.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]).toHaveLength(1)
    expect(restored.listAutomationRuns(DORMANT_AUTOMATION.id)).toHaveLength(1)
  })

  it('recovers a dormant commit lost before flush from the durable stage', async () => {
    const store = createStore()
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    store.stageOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()

    store.commitStagedOrcadMigrationCatalog(input)
    expect(store.getWorktreeMeta(DORMANT_WORKTREE_ID)?.comment).toBe('Preserve me')
    writeDataFile(stagedDiskState)

    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'staged' })
    expect(restored.getWorktreeMeta(DORMANT_WORKTREE_ID)).toBeUndefined()
    restored.commitStagedOrcadMigrationCatalog(input)
    await restored.flushPendingOrThrowAsync()

    const committed = createStore()
    expect(committed.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'committed' })
    expect(committed.getWorktreeMeta(DORMANT_WORKTREE_ID)?.comment).toBe('Preserve me')
  })

  it('merges a migrated retirement namespace while preserving the storage cap', async () => {
    const store = createStore()
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES; index += 1) {
      store.mergeRetiredWorktreeNamesForNamespace(`local:/existing/${index}`, ['nautilus'])
    }
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })

    store.stageOrcadMigrationCatalog(input)
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the raw data file is untyped JSON this test edits to simulate an older writer.
    const diskState = readDataFile() as Record<string, unknown>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the raw data file is untyped JSON this test edits to simulate an older writer.
    const namespaces = (diskState.retiredWorktreeNamesByNamespace ?? {}) as Record<string, unknown>
    expect(Object.keys(namespaces)).toHaveLength(MAX_RETIREMENT_NAMESPACES)
    expect(store.getRetiredWorktreeNameRegistryForNamespace(DORMANT_NAMESPACE).names).toContain(
      'seahorse'
    )
    expect(store.getRetiredWorktreeNameRegistryForNamespace('local:/existing/0').names).toEqual([])
  })

  it('rejects dormant-state conflicts before publishing any catalog row', () => {
    const store = createStore()
    store.setWorktreeMeta(DORMANT_WORKTREE_ID, {
      ...dormantState().worktreeMeta[0].meta,
      comment: 'Different owner'
    })
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })

    expect(() => store.stageOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:worktree_meta:${DORMANT_WORKTREE_ID}`
    )
    expect(store.getRepos()).toEqual([])
    expect(store.getProjectGroups()).toEqual([])
    expect(store.getFolderWorkspaces()).toEqual([])
  })

  it('rejects a dormant workspace-session owner conflict before publication', () => {
    const store = createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [DORMANT_WORKTREE_ID]: [
          {
            ...dormantState().workspaceSession!.tabsByWorktree[DORMANT_WORKTREE_ID][0],
            title: 'Destination terminal'
          }
        ]
      }
    })
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })

    expect(() => store.stageOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:tabsByWorktree:${DORMANT_WORKTREE_ID}`
    )
    expect(store.getRepos()).toEqual([])
  })

  it('rejects a dormant automation conflict before publishing a second migration', () => {
    const store = createStore()
    const base = manifest()
    const first = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    commitCatalog(store, first)
    const changedDormant = dormantState()
    const changedAutomation = changedDormant.automations?.[0]
    if (!changedAutomation) {
      throw new Error('expected dormant automation')
    }
    changedDormant.automations = [{ ...changedAutomation, name: 'Different destination owner' }]
    const second = manifest({
      migrationId: 'migration-automation-conflict',
      payload: { ...base.payload, dormantState: changedDormant }
    })

    expect(() => store.stageOrcadMigrationCatalog(second)).toThrow(
      `orcad_migration_dormant_id_conflict:automation:${DORMANT_AUTOMATION.id}`
    )
    expect(store.listAutomations()).toEqual([
      expect.objectContaining({ id: DORMANT_AUTOMATION.id, name: 'Nightly checks' })
    ])
  })

  it('rejects destination automation state with an in-flight run', () => {
    const store = createStore()
    const base = manifest()
    const first = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    commitCatalog(store, first)
    store.createAutomationRun(DORMANT_AUTOMATION, 10, 'manual')
    const nextDormant = dormantState()
    delete nextDormant.automationRuns
    const second = manifest({
      migrationId: 'migration-automation-active',
      payload: { ...base.payload, dormantState: nextDormant }
    })

    expect(() => store.stageOrcadMigrationCatalog(second)).toThrow(
      `orcad_migration_dormant_automation_run_active:${DORMANT_AUTOMATION.id}`
    )
    expect(store.getOrcadMigrationCatalogState(second)).toMatchObject({ state: 'absent' })
  })

  it('stages idempotently and rejects migration-id reuse before catalog mutation', () => {
    const store = createStore()
    const input = manifest()
    const first = store.stageOrcadMigrationCatalog(input)

    expect(store.stageOrcadMigrationCatalog(input)).toEqual(first)
    expect(() =>
      store.stageOrcadMigrationCatalog(
        manifest({ payload: { ...input.payload, repositories: [] } })
      )
    ).toThrow('orcad_migration_id_reused_with_different_manifest')
    expect(store.getRepos()).toEqual([])
  })

  it('aborts only matching staged state and never rolls back a committed catalog', () => {
    const store = createStore()
    const input = manifest()

    expect(store.abortStagedOrcadMigrationCatalog(input)).toMatchObject({
      state: 'absent',
      aborted: false
    })
    store.stageOrcadMigrationCatalog(input)
    expect(store.abortStagedOrcadMigrationCatalog(input)).toMatchObject({
      state: 'absent',
      aborted: true
    })
    store.stageOrcadMigrationCatalog(input)
    store.commitStagedOrcadMigrationCatalog(input)
    expect(store.abortStagedOrcadMigrationCatalog(input)).toMatchObject({
      state: 'committed',
      aborted: false
    })
    expect(store.getRepos()).toHaveLength(1)
  })

  it('requires a durable stage before commit and bounds concurrent dormant catalogs', () => {
    const store = createStore()
    const input = manifest()
    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_catalog_not_staged'
    )

    for (let index = 0; index < MAX_ORCAD_MIGRATION_STAGED_CATALOGS; index++) {
      store.stageOrcadMigrationCatalog(
        manifest({
          migrationId: `migration-${index + 1}`,
          payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
        })
      )
    }
    expect(() =>
      store.stageOrcadMigrationCatalog(manifest({ migrationId: 'migration-overflow' }))
    ).toThrow('orcad_migration_staging_capacity_exceeded')
    expect(store.getRepos()).toEqual([])

    // A week later no client came back: the stages expire and stop holding the server awake.
    const later = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    expect(store.hasStagedOrcadMigrationCatalog(later().getTime())).toBe(false)
    expect(
      store.stageOrcadMigrationCatalog(manifest({ migrationId: 'migration-overflow' }), {
        now: later
      })
    ).toMatchObject({ state: 'staged' })
  })

  it('retains exclusive staged claims after reload and releases them on dormant abort', async () => {
    const store = createStore()
    const first = manifest()
    const second = manifest({ migrationId: 'competing-migration' })
    store.stageOrcadMigrationCatalog(first)
    await store.flushPendingOrThrowAsync()
    const restored = createStore()
    expect(() => restored.stageOrcadMigrationCatalog(second)).toThrow(
      'orcad_migration_staged_claim_conflict:'
    )
    expect(restored.getOrcadMigrationCatalogState(first)).toMatchObject({ state: 'staged' })
    expect(restored.getOrcadMigrationCatalogState(second)).toMatchObject({ state: 'absent' })
    expect(restored.getRepos()).toEqual([])
    expect(restored.abortStagedOrcadMigrationCatalog(first).aborted).toBe(true)
    await restored.flushPendingOrThrowAsync()
    const afterAbort = createStore()
    expect(afterAbort.stageOrcadMigrationCatalog(second)).toMatchObject({ state: 'staged' })
    expect(afterAbort.commitStagedOrcadMigrationCatalog(second)).toMatchObject({
      state: 'committed'
    })
  })

  it('refuses committing overlapping stages loaded from an older writer', async () => {
    const store = createStore()
    const first = manifest()
    const second = manifest({ migrationId: 'older-competing-stage' })
    store.stageOrcadMigrationCatalog(first)
    await store.flushPendingOrThrowAsync()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the raw data file is untyped JSON this test edits to simulate an older writer.
    const persisted = readDataFile() as Record<string, unknown>
    persisted.orcadMigrationStagedCatalogs = [first, second].map((entry) => ({
      version: 1,
      manifest: entry,
      stagedAt: entry.createdAt
    }))
    writeDataFile(persisted)
    const restored = createStore()
    for (const entry of [first, second]) {
      expect(() => restored.commitStagedOrcadMigrationCatalog(entry)).toThrow(
        'orcad_migration_staged_claim_conflict:'
      )
      expect(restored.getOrcadMigrationCatalogState(entry)).toMatchObject({ state: 'staged' })
    }
    expect(restored.getRepos()).toEqual([])
    expect(restored.abortStagedOrcadMigrationCatalog(second).aborted).toBe(true)
    expect(restored.commitStagedOrcadMigrationCatalog(first)).toMatchObject({ state: 'committed' })
  })

  it('reconstructs a missing receipt without duplicating identical catalog or dormant state', async () => {
    const store = createStore()
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    commitCatalog(store, input)
    await store.flushPendingOrThrowAsync()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the raw data file is untyped JSON this test edits to simulate an older writer.
    const persisted = readDataFile() as Record<string, unknown>
    delete persisted.orcadMigrationImportReceipts
    writeDataFile(persisted)

    const restored = createStore()
    const replay = commitCatalog(restored, input)

    expect(replay.state).toBe('committed')
    expect(restored.getRepos()).toHaveLength(1)
    expect(restored.getProjectGroups()).toHaveLength(1)
    expect(restored.getFolderWorkspaces()).toHaveLength(1)
    expect(restored.getWorktreeMeta(DORMANT_WORKTREE_ID)?.comment).toBe('Preserve me')
    expect(restored.getSparsePresets(REPOSITORY.id)).toHaveLength(1)
  })

  it('still reads a commit as committed after the live server changed what it imported', () => {
    const store = createStore()
    const input = manifest()
    commitCatalog(store, input)
    store.removeProject(REPOSITORY.id)

    expect(store.getOrcadMigrationCatalogState(input).state).toBe('committed')
    expect(store.getRepos()).toEqual([])
  })

  it('rejects an id reuse with a different manifest without duplicating state', () => {
    const store = createStore()
    const input = manifest()
    commitCatalog(store, input)
    const changed = manifest({
      payload: {
        ...input.payload,
        repositories: [{ ...REPOSITORY, displayName: 'Changed' }]
      }
    })

    expect(() => commitCatalog(store, changed)).toThrow(
      'orcad_migration_id_reused_with_different_manifest'
    )
    expect(store.getRepos()).toHaveLength(1)
  })

  it('validates all path conflicts before adding any manifest row', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'existing', path: REPOSITORY.path }))

    expect(() => commitCatalog(store, manifest())).toThrow(
      `orcad_migration_repository_path_conflict:${REPOSITORY.path}`
    )
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['existing'])
    expect(store.getProjectGroups()).toEqual([])
    expect(store.getFolderWorkspaces()).toEqual([])
  })

  it('validates all id conflicts before adding any manifest row', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: REPOSITORY.id, path: '/srv/different' }))

    expect(() => commitCatalog(store, manifest())).toThrow(
      `orcad_migration_repository_id_conflict:${REPOSITORY.id}`
    )
    expect(store.getRepos().map((repo) => repo.path)).toEqual(['/srv/different'])
    expect(store.getProjectGroups()).toEqual([])
    expect(store.getFolderWorkspaces()).toEqual([])
  })

  it('rejects missing group references before mutation', () => {
    const store = createStore()
    const input = manifest()
    const invalid = manifest({
      payload: { ...input.payload, projectGroups: [] }
    })

    expect(() => commitCatalog(store, invalid)).toThrow(
      'orcad_migration_repository_project_group_missing:repo-1'
    )
    expect(store.getRepos()).toEqual([])
    expect(store.getProjectGroups()).toEqual([])
    expect(store.getFolderWorkspaces()).toEqual([])
  })
})
