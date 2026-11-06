import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import type {
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { manifest } from './persistence-orcad-migration-catalog-fixture'
import { createStore, testState, writeDataFile } from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({}))
}))

const CHILD = 'repo-1::/srv/child'
const CHILD_KEY = `worktree:${CHILD}` as const

const worktreeParent = (confidence: 'explicit' | 'inferred'): WorktreeLineage => ({
  worktreeId: CHILD,
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: 'repo-1::/srv/parent',
  parentWorktreeInstanceId: 'parent-instance',
  origin: confidence === 'explicit' ? 'manual' : 'orchestration',
  capture:
    confidence === 'explicit'
      ? { source: 'manual-action', confidence }
      : { source: 'orchestration-context', confidence },
  createdAt: 1
})

const folderParent: WorkspaceLineage = {
  childWorkspaceKey: CHILD_KEY,
  childInstanceId: 'child-instance',
  parentWorkspaceKey: 'folder:folder-1',
  parentInstanceId: null,
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 2
}

function withLineage(
  worktreeLineage: WorktreeLineage[],
  workspaceLineage: WorkspaceLineage[]
): OrcadMigrationManifest {
  const dormantState: OrcadMigrationDormantStatePayload = {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: worktreeLineage.map((lineage) => ({
      sourceKey: CHILD,
      worktreeId: CHILD,
      lineage
    })),
    workspaceLineage: workspaceLineage.map((lineage) => ({
      sourceKey: CHILD_KEY,
      childWorkspaceKey: CHILD_KEY,
      lineage
    })),
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
  return manifest({ payload: { ...manifest().payload, dormantState } })
}

function commit(store: ReturnType<typeof createStore>, input: OrcadMigrationManifest) {
  store.stageOrcadMigrationCatalog(input)
  return store.commitStagedOrcadMigrationCatalog(input)
}

describe('orcad migration lineage', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-lineage-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([false, true])(
    'keeps an imported folder parent over an inferred worktree parent saved here (payload repeats it: %s)',
    (repeatsSavedRow) => {
      writeDataFile({
        ...getDefaultPersistedState(testState.dir),
        worktreeLineageById: { [CHILD]: worktreeParent('inferred') }
      })
      const store = createStore()

      commit(
        store,
        withLineage(repeatsSavedRow ? [worktreeParent('inferred')] : [], [folderParent])
      )

      expect(store.getWorktreeLineage(CHILD)).toBeUndefined()
      expect(store.getWorkspaceLineage(CHILD_KEY)?.parentWorkspaceKey).toBe('folder:folder-1')
    }
  )

  it('refuses a payload whose worktree has two explicit parents, changing nothing', () => {
    const store = createStore()

    expect(() => commit(store, withLineage([worktreeParent('explicit')], [folderParent]))).toThrow(
      'orcad_migration_dormant_id_conflict:lineage_parent'
    )

    expect(store.getRepos()).toEqual([])
    expect(store.getWorktreeLineage(CHILD)).toBeUndefined()
    expect(store.getWorkspaceLineage(CHILD_KEY)).toBeUndefined()
  })

  it('refuses a folder parent for a worktree whose parent is on another machine', () => {
    const store = createStore()
    store.setCrossStoreWorkspaceLineage(
      {
        childWorkspaceKey: CHILD_KEY,
        childInstanceId: 'child-instance',
        parent: {
          installationId: 'other-install',
          workspaceKey: 'worktree:other-repo::/srv/parent',
          instanceId: 'other-parent'
        },
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      },
      'local'
    )

    expect(() => commit(store, withLineage([], [folderParent]))).toThrow(
      'orcad_migration_dormant_id_conflict:lineage_parent'
    )

    expect(store.getRepos()).toEqual([])
    expect(store.getWorkspaceLineage(CHILD_KEY)).toBeUndefined()
    expect(store.getCrossStoreWorkspaceLineage(CHILD_KEY)?.parent.installationId).toBe(
      'other-install'
    )
  })
})
