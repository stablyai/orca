import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../shared/orcad-migration-manifest'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../shared/orcad-migration-scrollback'
import { computeOrcadMigrationManifestSha256 } from './orcad/orcad-migration-manifest-digest'
import { createStore, readDataFile, testState, writeDataFile } from './persistence-test-harness'
import { readTerminalScrollbackStoredBytesSync } from './terminal-scrollback-snapshots'

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

const BYTES = Buffer.from('preserve exact UTF-8 🐡 bytes', 'utf8')
const DESCRIPTOR: OrcadMigrationTerminalScrollbackSnapshot = {
  tabId: 'tab-scrollback',
  leafId: '11111111-1111-4111-8111-111111111111',
  ref: `v1-${'1'.repeat(32)}`,
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  byteLength: BYTES.length
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-scrollback-catalog-'))
})

afterEach(() => rmSync(testState.dir, { recursive: true, force: true }))

describe('orcad migration scrollback catalog persistence', () => {
  it('resumes upload from durable file length and publishes refs only after complete bytes', async () => {
    const input = manifest('resume')
    const store = createStore()
    expect(store.stageOrcadMigrationCatalog(input)).toMatchObject({
      state: 'staged',
      snapshotUploads: [{ ref: DESCRIPTOR.ref, receivedBytes: 0 }]
    })
    const firstLength = 7
    store.stageOrcadMigrationSnapshotChunk(request(input, 0, BYTES.subarray(0, firstLength)))
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      snapshotUploads: [{ ref: DESCRIPTOR.ref, receivedBytes: firstLength }]
    })
    expect(restored.getWorkspaceSession().terminalLayoutsByTabId).toEqual({})
    restored.stageOrcadMigrationSnapshotChunk(
      request(input, firstLength, BYTES.subarray(firstLength))
    )
    restored.commitStagedOrcadMigrationCatalog(input)

    expect(restored.getWorkspaceSession().terminalLayoutsByTabId[DESCRIPTOR.tabId]).toMatchObject({
      scrollbackRefsByLeafId: { [DESCRIPTOR.leafId]: DESCRIPTOR.ref }
    })
    expect(readSnapshot()).toEqual(BYTES)
    await restored.flushPendingOrThrowAsync()
    const committed = createStore()
    expect(committed.getWorkspaceSession().terminalLayoutsByTabId[DESCRIPTOR.tabId]).toEqual(
      input.payload.dormantState?.workspaceSession?.terminalLayoutsByTabId[DESCRIPTOR.tabId]
    )
    expect(committed.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'committed' })
  })

  it('recovers materialized files after a crash before the catalog receipt flush', async () => {
    const input = manifest('crash-before-receipt')
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    store.stageOrcadMigrationSnapshotChunk(request(input, 0, BYTES))
    store.commitStagedOrcadMigrationCatalog(input)
    expect(readSnapshot()).toEqual(BYTES)

    writeDataFile(stagedDiskState)
    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      snapshotUploads: [{ ref: DESCRIPTOR.ref, receivedBytes: BYTES.length }]
    })
    expect(restored.getRepos()).toEqual([])
    restored.commitStagedOrcadMigrationCatalog(input)
    await restored.flushPendingOrThrowAsync()

    const committed = createStore()
    expect(committed.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'committed' })
    expect(committed.getRepos()).toHaveLength(1)
    expect(readSnapshot()).toEqual(BYTES)
  })
})

function manifest(migrationId: string): OrcadMigrationManifest {
  const workspaceSession = getDefaultWorkspaceSession()
  const worktreeId = 'repo-1::/srv/worktree'
  workspaceSession.tabsByWorktree = {
    [worktreeId]: [
      {
        id: DESCRIPTOR.tabId,
        ptyId: null,
        worktreeId,
        title: 'Dormant terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  workspaceSession.terminalLayoutsByTabId = {
    [DESCRIPTOR.tabId]: {
      root: { type: 'leaf', leafId: DESCRIPTOR.leafId },
      activeLeafId: DESCRIPTOR.leafId,
      expandedLeafId: null,
      scrollbackRefsByLeafId: { [DESCRIPTOR.leafId]: DESCRIPTOR.ref }
    }
  }
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
    payload: {
      repositories: [
        {
          id: 'repo-1',
          path: '/srv/repo-1',
          displayName: 'Repository',
          badgeColor: '#737373',
          addedAt: 1,
          kind: 'git' as const
        }
      ],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1 as const,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        workspaceSession,
        terminalScrollbackSnapshots: [DESCRIPTOR]
      }
    }
  }
  return { ...unsigned, manifestSha256: computeOrcadMigrationManifestSha256(unsigned) }
}

function request(manifest: OrcadMigrationManifest, offset: number, bytes: Buffer) {
  return {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    ref: DESCRIPTOR.ref,
    offset,
    bytesBase64: bytes.toString('base64')
  }
}

function readSnapshot(): Buffer | null {
  return readTerminalScrollbackStoredBytesSync(DESCRIPTOR.ref, {
    snapshotRoot: join(testState.dir, 'terminal-scrollback')
  })
}
