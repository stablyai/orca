import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'
import type {
  CrossStoreWorkspaceLineage,
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../shared/worktree/lineage-types'
import { parseOrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { manifest } from './persistence-orcad-migration-catalog-fixture'
import { createStore, testState } from '../../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({}))
}))

const CHILD = 'repo-1::/srv/child'
const CHILD_KEY = `worktree:${CHILD}` as const

const folderParent: WorkspaceLineage = {
  childWorkspaceKey: CHILD_KEY,
  childInstanceId: 'child-instance',
  parentWorkspaceKey: 'folder:folder-1',
  parentInstanceId: null,
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 2
}

const crossMachineParent: CrossStoreWorkspaceLineage = {
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
  // The real parser and its reference checks admit the payload, as a staged import would.
  return parseOrcadMigrationManifest(manifest({ payload: { ...manifest().payload, dormantState } }))
}

describe('orcad migration lineage', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-lineage-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses at commit when a parent on another machine appears after staging', () => {
    const store = createStore()
    const input = withLineage([], [folderParent])
    store.stageOrcadMigrationCatalog(input)
    store.setCrossStoreWorkspaceLineage(crossMachineParent, 'local')

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_dormant_id_conflict:lineage_parent'
    )

    expect(store.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'staged' })
    expect(store.getRepos()).toEqual([])
    expect(store.getWorkspaceLineage(CHILD_KEY)).toBeUndefined()
    expect(store.getCrossStoreWorkspaceLineage(CHILD_KEY)?.parent.installationId).toBe(
      'other-install'
    )
  })
})
