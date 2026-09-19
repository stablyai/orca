import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import {
  decodeOrcadMigrationSnapshotChunk,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotUploadState,
  type OrcadMigrationTerminalScrollbackSnapshot
} from '../../../shared/orcad-migration-scrollback'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  getTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'

const STAGING_DIRECTORY = '.orcad-migration-staging'

export function stageOrcadMigrationSnapshotChunk(args: {
  state: PersistedState
  storage: TerminalScrollbackSnapshotStorage
  request: OrcadMigrationSnapshotChunkRequest
}): OrcadMigrationSnapshotChunkResult {
  const manifest = requireStagedManifest(args.state, args.request)
  const descriptor = requireDescriptor(manifest, args.request.ref)
  const bytes = decodeOrcadMigrationSnapshotChunk(args.request.bytesBase64)
  const path = stagedSnapshotPath(args.storage, manifest, descriptor)
  mkdirSync(stagingDirectory(args.storage, manifest), { recursive: true, mode: 0o700 })
  const descriptorFd = openStagedFile(path)
  try {
    const size = statSync(path).size
    if (args.request.offset > size || args.request.offset + bytes.length > descriptor.byteLength) {
      throw new Error('orcad_migration_snapshot_offset_invalid')
    }
    if (args.request.offset < size) {
      if (args.request.offset + bytes.length > size) {
        throw new Error('orcad_migration_snapshot_offset_invalid')
      }
      const existing = Buffer.alloc(bytes.length)
      const read = readSync(descriptorFd, existing, 0, existing.length, args.request.offset)
      if (read !== bytes.length || !existing.equals(bytes)) {
        throw new Error('orcad_migration_snapshot_retry_mismatch')
      }
      return chunkResult(args.request, size)
    }
    const written = writeSync(descriptorFd, bytes, 0, bytes.length, args.request.offset)
    if (written !== bytes.length) {
      throw new Error('orcad_migration_snapshot_write_incomplete')
    }
    fsyncSync(descriptorFd)
    return chunkResult(args.request, size + bytes.length)
  } finally {
    closeSync(descriptorFd)
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
    receivedBytes: matchingFinalSnapshot(storage, descriptor)
      ? descriptor.byteLength
      : stagedSnapshotSize(storage, manifest, descriptor)
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
    if (!path || !fileMatches(path, upload)) {
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
    if (matchingFinalSnapshot(storage, descriptor)) {
      rmSync(stagedSnapshotPath(storage, manifest, descriptor), { force: true })
      continue
    }
    const stagedPath = stagedSnapshotPath(storage, manifest, descriptor)
    const finalPath = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
    if (!finalPath) {
      throw new Error('orcad_migration_snapshot_ref_invalid')
    }
    try {
      linkSync(stagedPath, finalPath)
    } catch (error) {
      const finalStatus = inspectFinalSnapshot(storage, descriptor)
      if (finalStatus === 'conflict') {
        throw new Error(`orcad_migration_snapshot_destination_conflict:${descriptor.ref}`)
      }
      if (finalStatus !== 'matching') {
        throw error
      }
    }
    rmSync(stagedPath, { force: true })
  }
  syncDirectoryDurablySync(root)
  removeStagingDirectory(storage, manifest)
}

export function abortOrcadMigrationSnapshots(
  manifest: OrcadMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  removeStagingDirectory(storage, manifest)
}

export function pruneOrcadMigrationSnapshotStaging(
  state: PersistedState,
  storage: TerminalScrollbackSnapshotStorage
): void {
  const root = join(getTerminalScrollbackSnapshotRoot(storage), STAGING_DIRECTORY)
  const retained = new Set(
    (state.orcadMigrationStagedCatalogs ?? []).map((entry) => stagingKey(entry.manifest))
  )
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (/^[a-f0-9]{32}$/.test(entry) && !retained.has(entry)) {
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  }
}

function requireStagedManifest(
  state: PersistedState,
  request: Pick<OrcadMigrationSnapshotChunkRequest, 'migrationId' | 'manifestSha256'>
): OrcadMigrationManifest {
  const staged = state.orcadMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === request.migrationId
  )?.manifest
  if (!staged || staged.manifestSha256 !== request.manifestSha256) {
    throw new Error('orcad_migration_snapshot_catalog_not_staged')
  }
  return staged
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

function stagedSnapshotSize(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): number {
  try {
    return Math.min(
      statSync(stagedSnapshotPath(storage, manifest, descriptor)).size,
      descriptor.byteLength
    )
  } catch {
    return 0
  }
}

function matchingFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): boolean {
  return inspectFinalSnapshot(storage, descriptor) === 'matching'
}

function inspectFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): 'absent' | 'matching' | 'conflict' {
  const path = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
  if (!path || !existsSync(path)) {
    return 'absent'
  }
  return fileMatches(path, descriptor) ? 'matching' : 'conflict'
}

function fileMatches(path: string, descriptor: OrcadMigrationTerminalScrollbackSnapshot): boolean {
  try {
    const bytes = readFileSync(path)
    return (
      bytes.length === descriptor.byteLength &&
      createHash('sha256').update(bytes).digest('hex') === descriptor.sha256
    )
  } catch {
    return false
  }
}

function openStagedFile(path: string): number {
  try {
    return openSync(path, 'r+')
  } catch {
    try {
      return openSync(path, 'wx+', 0o600)
    } catch {
      return openSync(path, 'r+')
    }
  }
}

function stagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest
): string {
  return join(getTerminalScrollbackSnapshotRoot(storage), STAGING_DIRECTORY, stagingKey(manifest))
}

function stagedSnapshotPath(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): string {
  return join(stagingDirectory(storage, manifest), `${descriptor.ref}.${descriptor.sha256}.part`)
}

function removeStagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: OrcadMigrationManifest
): void {
  const stagingRoot = join(getTerminalScrollbackSnapshotRoot(storage), STAGING_DIRECTORY)
  rmSync(stagingDirectory(storage, manifest), { recursive: true, force: true })
  syncDirectoryDurablySync(stagingRoot)
}

function stagingKey(manifest: OrcadMigrationManifest): string {
  return createHash('sha256')
    .update(`${manifest.migrationId}\0${manifest.manifestSha256}`)
    .digest('hex')
    .slice(0, 32)
}

function chunkResult(
  request: OrcadMigrationSnapshotChunkRequest,
  acknowledgedOffset: number
): OrcadMigrationSnapshotChunkResult {
  return {
    migrationId: request.migrationId,
    manifestSha256: request.manifestSha256,
    ref: request.ref,
    acknowledgedOffset
  }
}
