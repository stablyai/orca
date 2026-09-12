import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationCatalogState,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../shared/orcad-migration-scrollback'
import { transferOrcadMigrationSnapshots } from './orcad-migration-snapshot-coordinator'

const BYTES = Buffer.from('resume these bytes', 'utf8')
const SNAPSHOT: OrcadMigrationTerminalScrollbackSnapshot = {
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ref: `v1-${'1'.repeat(32)}`,
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  byteLength: BYTES.length
}
const MANIFEST: OrcadMigrationManifest = {
  version: ORCAD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-1',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
  payload: {
    repositories: [],
    projectGroups: [],
    folderWorkspaces: [],
    dormantState: {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      terminalScrollbackSnapshots: [SNAPSHOT]
    }
  },
  manifestSha256: 'a'.repeat(64)
}
const CUTOVER: OrcadMigrationSourceCutover = {
  version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  phase: 'destination-staged',
  destinationEnvironmentId: 'environment-1',
  manifest: MANIFEST,
  startedAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:01:00.000Z',
  stagedAt: '2026-08-30T12:01:00.000Z'
}

describe('orcad migration snapshot coordinator', () => {
  it('resumes at the observed offset and reconciles a lost chunk response', async () => {
    const initialOffset = 4
    const sourceRead = vi.fn(() => ({
      bytesBase64: BYTES.subarray(initialOffset).toString('base64'),
      totalBytes: BYTES.length,
      eof: true
    }))
    const snapshotRequest = vi.fn()
    const remoteReads = [staged(BYTES.length), staged(BYTES.length)]

    await transferOrcadMigrationSnapshots({
      store: { readOrcadMigrationSourceSnapshotChunk: sourceRead },
      cutover: CUTOVER,
      pairingCode: 'pairing',
      state: staged(initialOffset),
      remote: {
        snapshot: async (_pairingCode, request) => {
          snapshotRequest(request)
          throw new Error('response lost')
        },
        read: async () => nextState(remoteReads)
      },
      requestOptions: {}
    })

    expect(sourceRead).toHaveBeenCalledWith(MANIFEST.migrationId, SNAPSHOT.ref, initialOffset)
    expect(snapshotRequest).toHaveBeenCalledWith(
      expect.objectContaining({ offset: initialOffset, ref: SNAPSHOT.ref })
    )
    expect(remoteReads).toEqual([])
  })

  it('fails closed when an old host omits snapshot upload state', async () => {
    const sourceRead = vi.fn()
    await expect(
      transferOrcadMigrationSnapshots({
        store: { readOrcadMigrationSourceSnapshotChunk: sourceRead },
        cutover: CUTOVER,
        pairingCode: 'pairing',
        state: staged(),
        remote: {
          snapshot: async () => {
            throw new Error('must not upload')
          },
          read: async () => staged()
        },
        requestOptions: {}
      })
    ).rejects.toThrow('orcad_migration_snapshot_transfer_unsupported')
    expect(sourceRead).not.toHaveBeenCalled()
  })

  it('keeps the source fence when the source length changes', async () => {
    await expect(
      transferOrcadMigrationSnapshots({
        store: {
          readOrcadMigrationSourceSnapshotChunk: () => ({
            bytesBase64: Buffer.from('changed').toString('base64'),
            totalBytes: BYTES.length + 1,
            eof: true
          })
        },
        cutover: CUTOVER,
        pairingCode: 'pairing',
        state: staged(0),
        remote: {
          snapshot: async () => {
            throw new Error('must not upload')
          },
          read: async () => staged(0)
        },
        requestOptions: {}
      })
    ).rejects.toThrow('orcad_migration_source_snapshot_changed')
  })

  it('requires complete upload evidence after the final chunk', async () => {
    const remoteReads = [staged(BYTES.length - 1)]
    await expect(
      transferOrcadMigrationSnapshots({
        store: { readOrcadMigrationSourceSnapshotChunk: vi.fn() },
        cutover: CUTOVER,
        pairingCode: 'pairing',
        state: staged(BYTES.length),
        remote: {
          snapshot: async () => {
            throw new Error('must not upload')
          },
          read: async () => nextState(remoteReads)
        },
        requestOptions: {}
      })
    ).rejects.toThrow('orcad_migration_snapshot_transfer_incomplete')
  })
})

function staged(receivedBytes?: number): Extract<OrcadMigrationCatalogState, { state: 'staged' }> {
  return {
    state: 'staged',
    migrationId: MANIFEST.migrationId,
    manifestSha256: MANIFEST.manifestSha256,
    stagedAt: '2026-08-30T12:01:00.000Z',
    ...(receivedBytes === undefined ? {} : { snapshotUploads: [{ ...SNAPSHOT, receivedBytes }] })
  }
}

function nextState(
  states: Extract<OrcadMigrationCatalogState, { state: 'staged' }>[]
): Extract<OrcadMigrationCatalogState, { state: 'staged' }> {
  const state = states.shift()
  if (!state) {
    throw new Error('unexpected remote read')
  }
  return state
}
