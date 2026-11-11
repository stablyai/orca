import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DORMANT_AUTOMATION,
  DORMANT_WORKTREE_ID,
  REPOSITORY,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'
import { createStore, readDataFile, testState, writeDataFile } from '../../persistence-test-harness'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

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

vi.mock('../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

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

  // Two desktops on one host each carry their own focus; the second must not be refused for it.

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

  it('rejects dormant-state conflicts before publishing any catalog row', () => {
    const store = createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: DORMANT_WORKTREE_ID, hostId: 'local' }), {
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

  it('still reads a commit as committed after the live server changed what it imported', () => {
    const store = createStore()
    const input = manifest()
    commitCatalog(store, input)
    store.removeProjectForHost({ id: REPOSITORY.id, executionHostId: 'local' })

    expect(store.getOrcadMigrationCatalogState(input).state).toBe('committed')
    expect(store.getRepos()).toEqual([])
  })
})
