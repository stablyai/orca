/**
 * R47: "Use on this computer again" can hand a later WSL move the generation number an earlier one
 * used. The host stages, commits and keeps receipts by migration id and manifest digest, so two
 * moves sharing a generation never collide; only the desktop's planner reads the generation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest'
import type { Repo } from '../../../../shared/repo-types'
import { manifest } from './persistence-orcad-migration-catalog-fixture'
import { createStore, testState } from '../../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

const GENERATION = 3

function wslMove(migrationId: string, repoId: string): OrcadMigrationManifest {
  const repo: Repo = {
    id: repoId,
    path: `/home/dev/${repoId}`,
    displayName: repoId,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git'
  }
  return manifest({
    migrationId,
    source: {
      kind: 'local-wsl',
      distro: 'Ubuntu',
      scopeRepoIds: [repoId],
      scopeFolderWorkspaceIds: [],
      generation: GENERATION
    },
    payload: { repositories: [repo], projectGroups: [], folderWorkspaces: [] }
  })
}

describe('two WSL moves that share a generation number', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-wsl-generation-reuse-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('abort one without touching the other', () => {
    const store = createStore()
    const earlier = wslMove('move-earlier', 'repo-a')
    const later = wslMove('move-later', 'repo-b')
    store.stageOrcadMigrationCatalog(earlier)
    store.stageOrcadMigrationCatalog(later)

    expect(store.abortStagedOrcadMigrationCatalog(later)).toMatchObject({ aborted: true })
    expect(store.getOrcadMigrationCatalogState(earlier).state).toBe('staged')
    expect(store.commitStagedOrcadMigrationCatalog(earlier).state).toBe('committed')
    expect(store.getOrcadMigrationCatalogState(later).state).toBe('absent')
  })
})
