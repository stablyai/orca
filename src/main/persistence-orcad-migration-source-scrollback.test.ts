import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from '../shared/orcad-migration-manifest'
import type { SshTarget } from '../shared/ssh-types'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { createStore, testState } from './persistence-test-harness'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'
import { retireOrcadMigrationSourceCatalogDurably } from './ssh/orcad-migration-cutover-coordinator'
import {
  getTerminalScrollbackSnapshotPath,
  makeTerminalScrollbackSnapshotRef,
  writeTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 1 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').slice('encrypted:'.length)
  }
}))
vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 8
}
const WORKTREE_ID = 'repo-1::/srv/repo-1-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-source-scrollback-'))
})

afterEach(() => rmSync(testState.dir, { recursive: true, force: true }))

describe('orcad migration source scrollback', () => {
  it('projects inline UTF-8 bytes exactly without changing the source session', () => {
    const store = sourceStore()
    const buffer = 'do not drop this 🐋'
    store.setWorkspaceSession(
      dormantSession(store, 'tab-inline', { buffersByLeafId: { [LEAF_ID]: buffer } }),
      `ssh:${TARGET.id}`
    )
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'inline' })
    const snapshot = requiredSnapshot(manifest)

    expect(snapshot).toEqual({
      tabId: 'tab-inline',
      leafId: LEAF_ID,
      ref: makeTerminalScrollbackSnapshotRef('tab-inline', LEAF_ID),
      sha256: createHash('sha256').update(Buffer.from(buffer, 'utf8')).digest('hex'),
      byteLength: Buffer.byteLength(buffer, 'utf8')
    })
    expect(
      manifest.payload.dormantState?.workspaceSession?.terminalLayoutsByTabId['tab-inline']
        ?.buffersByLeafId
    ).toBeUndefined()
    expect(
      store.getWorkspaceSession(`ssh:${TARGET.id}`).terminalLayoutsByTabId['tab-inline']
        ?.buffersByLeafId
    ).toEqual({ [LEAF_ID]: buffer })

    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest.migrationId, snapshot.ref, 0)
    expect(Buffer.from(chunk.bytesBase64, 'base64')).toEqual(Buffer.from(buffer, 'utf8'))
  })

  it('preserves source snapshot files through receipt-gated retirement for recovery', async () => {
    const store = sourceStore()
    const buffer = 'stored snapshot 🐙'
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-stored',
      leafId: LEAF_ID,
      buffer
    })
    if (!ref) {
      throw new Error('expected stored snapshot')
    }
    store.setWorkspaceSession(
      dormantSession(store, 'tab-stored', { scrollbackRefsByLeafId: { [LEAF_ID]: ref } }),
      `ssh:${TARGET.id}`
    )
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'stored' })
    const path = getTerminalScrollbackSnapshotPath(ref)

    expect(requiredSnapshot(manifest)).toMatchObject({
      ref,
      byteLength: Buffer.byteLength(buffer, 'utf8')
    })
    commitDestination(store, manifest)
    expect(path && existsSync(path)).toBe(true)
    await retireOrcadMigrationSourceCatalogDurably({ store, migrationId: manifest.migrationId })
    expect(path && existsSync(path)).toBe(true)
    expect(createStore().readTerminalScrollbackSnapshot(ref)).toBe(buffer)
  })

  it('preserves the prior durable profile and referenced bytes after a retirement flush failure', async () => {
    const store = sourceStore()
    const buffer = 'rollback must retain this 🐋'
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-flush',
      leafId: LEAF_ID,
      buffer
    })!
    store.setWorkspaceSession(
      dormantSession(store, 'tab-flush', {
        scrollbackRefsByLeafId: { [LEAF_ID]: ref }
      }),
      `ssh:${TARGET.id}`
    )
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'flush-failure' })
    commitDestination(store, manifest)
    await store.flushPendingOrThrowAsync()
    const flush = vi
      .spyOn(store, 'flushPendingOrThrowAsync')
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(
      retireOrcadMigrationSourceCatalogDurably({ store, migrationId: manifest.migrationId })
    ).rejects.toThrow('disk full')
    const reopened = createStore()
    expect(reopened.getOrcadMigrationSourceCutover(manifest.migrationId)?.phase).toBe(
      'destination-committed'
    )
    expect(
      reopened.getWorkspaceSession(`ssh:${TARGET.id}`).terminalLayoutsByTabId['tab-flush']
        .scrollbackRefsByLeafId?.[LEAF_ID]
    ).toBe(ref)
    expect(reopened.readTerminalScrollbackSnapshot(ref)).toBe(buffer)
    flush.mockRestore()
    await retireOrcadMigrationSourceCatalogDurably({ store, migrationId: manifest.migrationId })
    expect(createStore().readTerminalScrollbackSnapshot(ref)).toBe(buffer)
  })

  it('preserves a retired source file while another session still references it', () => {
    const store = sourceStore()
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-shared',
      leafId: LEAF_ID,
      buffer: 'shared snapshot'
    })
    if (!ref) {
      throw new Error('expected stored snapshot')
    }
    store.setWorkspaceSession(
      dormantSession(store, 'tab-shared', { scrollbackRefsByLeafId: { [LEAF_ID]: ref } }),
      `ssh:${TARGET.id}`
    )
    const local = dormantSession(store, 'tab-local-reference', {
      scrollbackRefsByLeafId: { [LEAF_ID]: ref }
    })
    local.tabsByWorktree = {
      'other-repo::/local/worktree': [
        { ...local.tabsByWorktree[WORKTREE_ID][0], worktreeId: 'other-repo::/local/worktree' }
      ]
    }
    store.setWorkspaceSession(local)
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'shared-ref' })
    const path = getTerminalScrollbackSnapshotPath(ref)

    commitDestination(store, manifest)
    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)
    expect(path && existsSync(path)).toBe(true)
  })

  it('keeps the source fence and bytes when content drifts after fencing', () => {
    const store = sourceStore()
    store.setWorkspaceSession(
      dormantSession(store, 'tab-drift', { buffersByLeafId: { [LEAF_ID]: 'original' } }),
      `ssh:${TARGET.id}`
    )
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'drift' })
    const snapshot = requiredSnapshot(manifest)
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.setWorkspaceSession(
      dormantSession(store, 'tab-drift', { buffersByLeafId: { [LEAF_ID]: 'changed' } }),
      `ssh:${TARGET.id}`
    )

    expect(() =>
      store.readOrcadMigrationSourceSnapshotChunk(manifest.migrationId, snapshot.ref, 0)
    ).toThrow('orcad_migration_source_snapshot_changed')
    expect(store.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'source-fenced'
    })
    expect(
      store.getWorkspaceSession(`ssh:${TARGET.id}`).terminalLayoutsByTabId['tab-drift']
        ?.buffersByLeafId
    ).toEqual({ [LEAF_ID]: 'changed' })
  })

  it('blocks missing and oversized stored snapshots before assigning ownership', () => {
    for (const variant of ['missing', 'oversized'] as const) {
      const store = sourceStore()
      const tabId = `tab-${variant}`
      const ref = makeTerminalScrollbackSnapshotRef(tabId, LEAF_ID)
      if (variant === 'oversized') {
        const path = getTerminalScrollbackSnapshotPath(ref)
        if (!path) {
          throw new Error('expected snapshot path')
        }
        mkdirSync(join(testState.dir, 'terminal-scrollback'), { recursive: true })
        writeFileSync(path, Buffer.alloc(TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1))
      }
      store.setWorkspaceSession(
        dormantSession(store, tabId, { scrollbackRefsByLeafId: { [LEAF_ID]: ref } }),
        `ssh:${TARGET.id}`
      )
      const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: variant })

      expect(manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []).toEqual([])
      expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
        'orcad_migration_source_dependencies_present'
      )
      expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    }
  })
})

function sourceStore() {
  const store = createStore()
  store.addSshTarget(TARGET)
  const group = store.createProjectGroup({
    name: 'Production',
    parentPath: '/srv',
    connectionId: TARGET.id,
    createdFrom: 'manual'
  })
  store.addRepo({
    id: 'repo-1',
    path: '/srv/repo-1',
    displayName: 'Repository',
    badgeColor: '#737373',
    addedAt: 1,
    connectionId: TARGET.id,
    executionHostId: `ssh:${TARGET.id}`,
    projectGroupId: group.id
  })
  return store
}

function dormantSession(
  store: ReturnType<typeof sourceStore>,
  tabId: string,
  layout: Pick<
    WorkspaceSessionState['terminalLayoutsByTabId'][string],
    'buffersByLeafId' | 'scrollbackRefsByLeafId'
  >
): WorkspaceSessionState {
  return {
    ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Dormant terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ...layout
      }
    }
  }
}

function requiredSnapshot(manifest: OrcadMigrationManifest) {
  const snapshot = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]
  if (!snapshot) {
    throw new Error('expected snapshot descriptor')
  }
  return snapshot
}

function commitDestination(
  store: ReturnType<typeof sourceStore>,
  manifest: OrcadMigrationManifest
): void {
  store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
  const receipt: OrcadMigrationImportReceipt = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: manifest.source,
    importedAt: '2026-08-30T12:03:00.000Z',
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
    folderWorkspaceIds: []
  }
  store.markOrcadMigrationDestinationCommitted(manifest.migrationId, {
    state: 'committed',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    receipt
  })
}
