import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  decodeOrcadMigrationSnapshotChunk,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotUploadState,
  type OrcadMigrationTerminalScrollbackSnapshot
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  getTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  appendOrcadMigrationStagedChunk,
  ensureOrcadMigrationDirectory,
  inspectOrcadMigrationFinalFile,
  linkOrcadMigrationStagedFile,
  orcadMigrationFileMatches,
  orcadMigrationStagedFileSize,
  orcadMigrationStagingDirectory,
  pruneOrcadMigrationStagingDirectories,
  removeOrcadMigrationStagingDirectory,
  requireStagedOrcadMigrationManifest
} from './orcad-migration-staged-file'

/**
 * Destination side: append one verified chunk to the staging file for a snapshot the staged
 * manifest names. `stagedManifest` is the manifest the importer accepted; a request for any
 * other migration or digest is refused. Retries of an already-written range must match it.
 */
export function stageOrcadMigrationSnapshotChunk(args: {
  stagedManifest: OrcadMigrationManifest | null
  storage: TerminalScrollbackSnapshotStorage
  request: OrcadMigrationSnapshotChunkRequest
}): OrcadMigrationSnapshotChunkResult {
  const manifest = requireStagedOrcadMigrationManifest(
    args.stagedManifest,
    args.request,
    'orcad_migration_snapshot_catalog_not_staged'
  )
  const descriptor = requireDescriptor(manifest, args.request.ref)
  const bytes = decodeOrcadMigrationSnapshotChunk(args.request.bytesBase64)
  ensureOrcadMigrationDirectory(stagingDirectory(args.storage, manifest))
  const acknowledgedOffset = appendOrcadMigrationStagedChunk({
    channel: 'snapshot',
    path: stagedSnapshotPath(args.storage, manifest, descriptor),
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    ref: args.request.ref,
    acknowledgedOffset
  }
}

export function inspectOrcadMigrationSnapshotUploads(
  manifest: OrcadMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): OrcadMigrationSnapshotUploadState[] | undefined {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return undefined
  }
  return snapshots.map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectFinalSnapshot(storage, descriptor) === 'matching'
        ? descriptor.byteLength
        : orcadMigrationStagedFileSize(
            stagedSnapshotPath(storage, manifest, descriptor),
            descriptor.byteLength
          )
  }))
}

export function assertOrcadMigrationSnapshotsReady(
  manifest: OrcadMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  for (const upload of inspectOrcadMigrationSnapshotUploads(manifest, storage) ?? []) {
    const finalStatus = inspectFinalSnapshot(storage, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`orcad_migration_snapshot_destination_conflict:${upload.ref}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`orcad_migration_snapshot_incomplete:${upload.ref}`)
    }
    const path =
      finalStatus === 'matching'
        ? getTerminalScrollbackSnapshotPath(upload.ref, storage)
        : stagedSnapshotPath(storage, manifest, upload)
    if (!path || !orcadMigrationFileMatches(path, upload)) {
      throw new Error(`orcad_migration_snapshot_digest_mismatch:${upload.ref}`)
    }
  }
}

export function commitOrcadMigrationSnapshots(
  manifest: OrcadMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  assertOrcadMigrationSnapshotsReady(manifest, storage)
  const root = getTerminalScrollbackSnapshotRoot(storage)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const descriptor of snapshots) {
    const finalPath = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
    if (!finalPath) {
      throw new Error('orcad_migration_snapshot_ref_invalid')
    }
    linkOrcadMigrationStagedFile({
      stagedPath: stagedSnapshotPath(storage, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `orcad_migration_snapshot_destination_conflict:${descriptor.ref}`
    })
  }
  syncDirectoryDurablySync(root)
  removeOrcadMigrationStagingDirectory(root, manifest)
}

export function abortOrcadMigrationSnapshots(
  manifest: OrcadMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  removeOrcadMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

/** Removes staging for every migration the importer no longer holds staged. */
export function pruneOrcadMigrationSnapshotStaging(
  stagedManifests: readonly OrcadMigrationManifest[],
  storage: TerminalScrollbackSnapshotStorage
): void {
  pruneOrcadMigrationStagingDirectories(getTerminalScrollbackSnapshotRoot(storage), stagedManifests)
}

function requireDescriptor(
  manifest: OrcadMigrationManifest,
  ref: string
): OrcadMigrationTerminalScrollbackSnapshot {
  const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
    (entry) => entry.ref === ref
  )
  if (!descriptor) {
    throw new Error('orcad_migration_snapshot_unknown')
  }
  return descriptor
}

function inspectFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): 'absent' | 'matching' | 'conflict' {
  return inspectOrcadMigrationFinalFile(
    getTerminalScrollbackSnapshotPath(descriptor.ref, storage),
    descriptor
  )
}

function stagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest
): string {
  return orcadMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

function stagedSnapshotPath(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): string {
  return join(stagingDirectory(storage, manifest), `${descriptor.ref}.${descriptor.sha256}.part`)
}
