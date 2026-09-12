import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationTerminalScrollbackSnapshot
} from '../../../shared/orcad-migration-scrollback'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getTerminalScrollbackSnapshotPath,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  abortOrcadMigrationSnapshots,
  assertOrcadMigrationSnapshotsReady,
  commitOrcadMigrationSnapshots,
  inspectOrcadMigrationSnapshotUploads,
  pruneOrcadMigrationSnapshotStaging,
  stageOrcadMigrationSnapshotChunk
} from './orcad-scrollback-snapshot-transfer'

let root: string
let storage: TerminalScrollbackSnapshotStorage

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-migration-snapshots-'))
  storage = { snapshotRoot: join(root, 'terminal-scrollback') }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('orcad scrollback snapshot transfer', () => {
  it('resumes from staged byte length and accepts only exact idempotent retries', () => {
    const bytes = Buffer.from('first line\nmultibyte: 🐋\nlast line', 'utf8')
    const descriptor = snapshot('1', 'tab-1', 'leaf-1', bytes)
    const manifest = migrationManifest('resume', [descriptor])
    const state = stagedState(manifest)
    const first = bytes.subarray(0, 11)

    expect(stage(state, manifest, descriptor, 0, first).acknowledgedOffset).toBe(first.length)
    expect(inspectOrcadMigrationSnapshotUploads(manifest, storage)?.[0]?.receivedBytes).toBe(
      first.length
    )
    expect(stage(state, manifest, descriptor, 0, first).acknowledgedOffset).toBe(first.length)
    expect(() => stage(state, manifest, descriptor, 0, Buffer.from('different!!'))).toThrow(
      'orcad_migration_snapshot_retry_mismatch'
    )
    expect(() => stage(state, manifest, descriptor, first.length + 1, Buffer.from('x'))).toThrow(
      'orcad_migration_snapshot_offset_invalid'
    )

    stage(state, manifest, descriptor, first.length, bytes.subarray(first.length))
    assertOrcadMigrationSnapshotsReady(manifest, storage)
    commitOrcadMigrationSnapshots(manifest, storage)
    expect(readFinal(descriptor)).toEqual(bytes)
  })

  it('refuses incomplete and digest-mismatched staged bytes', () => {
    const bytes = Buffer.from('expected bytes', 'utf8')
    const descriptor = snapshot('2', 'tab-2', 'leaf-2', bytes)
    const manifest = migrationManifest('refuse', [descriptor])
    const state = stagedState(manifest)

    stage(state, manifest, descriptor, 0, bytes.subarray(0, 4))
    expect(() => assertOrcadMigrationSnapshotsReady(manifest, storage)).toThrow(
      'orcad_migration_snapshot_incomplete'
    )
    stage(state, manifest, descriptor, 4, Buffer.alloc(bytes.length - 4, 0x78))
    expect(() => assertOrcadMigrationSnapshotsReady(manifest, storage)).toThrow(
      'orcad_migration_snapshot_digest_mismatch'
    )
    expect(readFinal(descriptor)).toBeNull()
  })

  it('recognizes an already-materialized matching final file after restart', () => {
    const bytes = Buffer.from('already committed bytes', 'utf8')
    const descriptor = snapshot('3', 'tab-3', 'leaf-3', bytes)
    const manifest = migrationManifest('materialized', [descriptor])
    stagedState(manifest)
    writeFinal(descriptor, bytes)

    expect(inspectOrcadMigrationSnapshotUploads(manifest, storage)?.[0]?.receivedBytes).toBe(
      bytes.length
    )
    assertOrcadMigrationSnapshotsReady(manifest, storage)
    commitOrcadMigrationSnapshots(manifest, storage)
    expect(readFinal(descriptor)).toEqual(bytes)
  })

  it('rejects a same-ref content conflict before materializing any snapshot', () => {
    const firstBytes = Buffer.from('first snapshot', 'utf8')
    const secondBytes = Buffer.from('second snapshot', 'utf8')
    const first = snapshot('4', 'tab-4', 'leaf-4', firstBytes)
    const second = snapshot('5', 'tab-5', 'leaf-5', secondBytes)
    const manifest = migrationManifest('conflict', [first, second])
    const state = stagedState(manifest)
    stage(state, manifest, first, 0, firstBytes)
    stage(state, manifest, second, 0, secondBytes)
    writeFinal(second, Buffer.alloc(secondBytes.length, 0x78))

    expect(() => commitOrcadMigrationSnapshots(manifest, storage)).toThrow(
      `orcad_migration_snapshot_destination_conflict:${second.ref}`
    )
    expect(readFinal(first)).toBeNull()
    expect(readFinal(second)).toEqual(Buffer.alloc(secondBytes.length, 0x78))
  })

  it('removes only the selected staging tree and prunes unjournaled trees', () => {
    const bytes = Buffer.from('staged bytes', 'utf8')
    const firstDescriptor = snapshot('6', 'tab-6', 'leaf-6', bytes)
    const secondDescriptor = snapshot('7', 'tab-7', 'leaf-7', bytes)
    const first = migrationManifest('abort-first', [firstDescriptor])
    const second = migrationManifest('retain-second', [secondDescriptor])
    const state = stagedState(first, second)
    stage(state, first, firstDescriptor, 0, bytes)
    stage(state, second, secondDescriptor, 0, bytes)

    abortOrcadMigrationSnapshots(first, storage)
    expect(inspectOrcadMigrationSnapshotUploads(first, storage)?.[0]?.receivedBytes).toBe(0)
    expect(inspectOrcadMigrationSnapshotUploads(second, storage)?.[0]?.receivedBytes).toBe(
      bytes.length
    )
    state.orcadMigrationStagedCatalogs = state.orcadMigrationStagedCatalogs?.filter(
      (entry) => entry.manifest.migrationId !== second.migrationId
    )
    pruneOrcadMigrationSnapshotStaging(state, storage)
    expect(inspectOrcadMigrationSnapshotUploads(second, storage)?.[0]?.receivedBytes).toBe(0)
  })
})

function snapshot(
  suffix: string,
  tabId: string,
  leafId: string,
  bytes: Buffer
): OrcadMigrationTerminalScrollbackSnapshot {
  return {
    tabId,
    leafId,
    ref: `v1-${suffix.repeat(32)}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
}

function migrationManifest(
  migrationId: string,
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
): OrcadMigrationManifest {
  const workspaceSession = getDefaultWorkspaceSession()
  workspaceSession.terminalLayoutsByTabId = Object.fromEntries(
    snapshots.map((entry) => [
      entry.tabId,
      {
        root: { type: 'leaf' as const, leafId: entry.leafId },
        activeLeafId: entry.leafId,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [entry.leafId]: entry.ref }
      }
    ])
  )
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
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
        workspaceSession,
        terminalScrollbackSnapshots: snapshots
      }
    },
    manifestSha256: 'a'.repeat(64)
  }
}

function stagedState(...manifests: OrcadMigrationManifest[]): PersistedState {
  return {
    ...getDefaultPersistedState(root),
    orcadMigrationStagedCatalogs: manifests.map((manifest) => ({
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      manifest,
      stagedAt: '2026-08-30T12:01:00.000Z'
    }))
  }
}

function stage(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot,
  offset: number,
  bytes: Buffer
) {
  const request: OrcadMigrationSnapshotChunkRequest = {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    ref: descriptor.ref,
    offset,
    bytesBase64: bytes.toString('base64')
  }
  return stageOrcadMigrationSnapshotChunk({ state, storage, request })
}

function writeFinal(descriptor: OrcadMigrationTerminalScrollbackSnapshot, bytes: Buffer): void {
  const path = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
  if (!path) {
    throw new Error('expected snapshot path')
  }
  if (!storage.snapshotRoot) {
    throw new Error('expected snapshot root')
  }
  mkdirSync(storage.snapshotRoot, { recursive: true })
  writeFileSync(path, bytes)
}

function readFinal(descriptor: OrcadMigrationTerminalScrollbackSnapshot): Buffer | null {
  const path = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
  return path && existsSync(path) ? readFileSync(path) : null
}
