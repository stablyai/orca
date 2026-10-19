/**
 * Destination side of the migration blob channel. Blobs are not named by the signed manifest, so
 * a staged file's name carries its whole descriptor (`<key>.<sha256>.<byteLength>.part` under a
 * per-kind directory) and the staged set is read back from disk after a restart. At catalog commit
 * every staged blob must be complete and digest-exact, then moves to the migration's received
 * directory; installing received blobs into live state is each kind's installer (D1b-6b/6c).
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ORCAD_MIGRATION_BLOB_KINDS,
  assertOrcadMigrationBlobSet,
  decodeOrcadMigrationBlobChunk,
  orcadMigrationBlobIdentity,
  parseOrcadMigrationBlobDescriptor,
  sameOrcadMigrationBlob,
  type OrcadMigrationBlobChunkRequest,
  type OrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobDescriptor,
  type OrcadMigrationBlobKind,
  type OrcadMigrationBlobUploadState
} from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  appendOrcadMigrationStagedChunk,
  ensureOrcadMigrationDirectory,
  inspectOrcadMigrationFinalFile,
  linkOrcadMigrationStagedFile,
  orcadMigrationFileMatches,
  orcadMigrationStagedFileSize,
  orcadMigrationStagingDirectory,
  orcadMigrationStagingKey,
  pruneOrcadMigrationKeyedDirectories,
  pruneOrcadMigrationStagingDirectories,
  removeOrcadMigrationStagingDirectory,
  requireStagedOrcadMigrationManifest,
  type OrcadMigrationRequestIdentity
} from './orcad-migration-staged-file'

const RECEIVED_DIRECTORY = 'received'
const STAGED_BLOB_NAME = /^([^.]+)\.([a-f0-9]{64})\.([1-9][0-9]*)\.part$/

type OrcadMigrationBlobName = Pick<OrcadMigrationBlobDescriptor, 'blobKind' | 'key'>

type ReceivedBlobPathResolver = (
  root: string,
  manifest: OrcadMigrationRequestIdentity,
  descriptor: OrcadMigrationBlobName
) => string

const receivedDirectoryPath: ReceivedBlobPathResolver = (root, manifest, descriptor) =>
  join(receivedBlobsDirectory(root, manifest), descriptor.blobKind, descriptor.key)

/** Where each kind lands at commit; every kind waits in the received directory for its installer. */
const RECEIVED_BLOB_DESTINATIONS: Record<OrcadMigrationBlobKind, ReceivedBlobPathResolver> = {
  'terminal-restore-hints': receivedDirectoryPath,
  'shell-history': receivedDirectoryPath,
  'agent-session-records': receivedDirectoryPath,
  'editor-drafts': receivedDirectoryPath
}

export function getOrcadMigrationReceivedBlobPath(
  root: string,
  manifest: OrcadMigrationRequestIdentity,
  descriptor: OrcadMigrationBlobName
): string {
  return RECEIVED_BLOB_DESTINATIONS[descriptor.blobKind](root, manifest, descriptor)
}

/** Names in a committed migration's received directory for `blobKind`; the caller checks the key. */
export function listOrcadMigrationReceivedBlobNames(
  root: string,
  manifest: OrcadMigrationRequestIdentity,
  blobKind: OrcadMigrationBlobKind
): string[] {
  return readDirectory(join(receivedBlobsDirectory(root, manifest), blobKind))
}

export type OrcadMigrationBlobChunkStaging = {
  /** The manifest the importer holds staged for this migration, if any. */
  stagedManifest: OrcadMigrationManifest | null
  root: string
  request: OrcadMigrationBlobChunkRequest
}

export function stageOrcadMigrationBlobChunk(
  args: OrcadMigrationBlobChunkStaging
): OrcadMigrationBlobChunkResult {
  const manifest = requireStagedOrcadMigrationManifest(
    args.stagedManifest,
    args.request,
    'orcad_migration_blob_catalog_not_staged'
  )
  const descriptor = parseOrcadMigrationBlobDescriptor(args.request.blob)
  const bytes = decodeOrcadMigrationBlobChunk(args.request.bytesBase64)
  const staged = stagedBlobDescriptors(args.root, manifest)
  const existing = staged.find(
    (entry) => orcadMigrationBlobIdentity(entry) === orcadMigrationBlobIdentity(descriptor)
  )
  if (existing && !sameOrcadMigrationBlob(existing, descriptor)) {
    // Never replace bytes already staged under this key; the sender aborts and restages instead.
    throw new Error(`orcad_migration_blob_descriptor_conflict:${descriptor.blobKind}`)
  }
  if (!existing) {
    assertOrcadMigrationBlobSet([...staged, descriptor])
  }
  const path = stagedBlobPath(args.root, manifest, descriptor)
  ensureOrcadMigrationDirectory(dirname(path))
  const receivedBytes = appendOrcadMigrationStagedChunk({
    channel: 'blob',
    path,
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    blobKind: descriptor.blobKind,
    key: descriptor.key,
    receivedBytes
  }
}

export function inspectOrcadMigrationBlobUploads(
  manifest: OrcadMigrationManifest,
  root: string
): OrcadMigrationBlobUploadState[] | undefined {
  const uploads = stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectReceivedBlob(root, manifest, descriptor) === 'matching'
        ? descriptor.byteLength
        : orcadMigrationStagedFileSize(
            stagedBlobPath(root, manifest, descriptor),
            descriptor.byteLength
          )
  }))
  return uploads.length > 0 ? uploads : undefined
}

export function assertOrcadMigrationBlobsReady(
  manifest: OrcadMigrationManifest,
  root: string
): void {
  for (const upload of inspectOrcadMigrationBlobUploads(manifest, root) ?? []) {
    const label = `${upload.blobKind}:${upload.key}`
    const finalStatus = inspectReceivedBlob(root, manifest, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`orcad_migration_blob_destination_conflict:${label}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`orcad_migration_blob_incomplete:${label}`)
    }
    if (
      finalStatus !== 'matching' &&
      !orcadMigrationFileMatches(stagedBlobPath(root, manifest, upload), upload)
    ) {
      throw new Error(`orcad_migration_blob_digest_mismatch:${label}`)
    }
  }
}

/**
 * Each still-staged blob's verified file; one an earlier attempt already moved was checked then.
 * Only meaningful after `assertOrcadMigrationBlobsReady` in the same synchronous turn.
 */
export function stagedOrcadMigrationBlobFiles(
  manifest: OrcadMigrationManifest,
  root: string
): { descriptor: OrcadMigrationBlobDescriptor; path: string }[] {
  return stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    descriptor,
    path: stagedBlobPath(root, manifest, descriptor)
  }))
}

/**
 * Refuses commit unless the staged and already-received blobs are exactly the set the sender
 * moved, so a blob lost on the way (or left from another capture) fails instead of vanishing.
 */
export function assertOrcadMigrationBlobSetMatches(
  manifest: OrcadMigrationManifest,
  root: string,
  expected: readonly OrcadMigrationBlobDescriptor[]
): void {
  assertOrcadMigrationBlobSet(expected)
  const wanted = new Map(expected.map((entry) => [orcadMigrationBlobIdentity(entry), entry]))
  const staged = stagedBlobDescriptors(root, manifest)
  const stagedIds = new Set(staged.map(orcadMigrationBlobIdentity))
  for (const descriptor of staged) {
    const match = wanted.get(orcadMigrationBlobIdentity(descriptor))
    if (!match || !sameOrcadMigrationBlob(match, descriptor)) {
      throw blobSetMismatch(descriptor)
    }
  }
  for (const identity of receivedBlobIdentities(root, manifest)) {
    if (!wanted.has(identity)) {
      throw new Error('orcad_migration_blob_set_mismatch')
    }
  }
  for (const descriptor of expected) {
    // An earlier commit attempt may already have moved it; the received bytes must still match.
    if (
      !stagedIds.has(orcadMigrationBlobIdentity(descriptor)) &&
      inspectReceivedBlob(root, manifest, descriptor) !== 'matching'
    ) {
      throw blobSetMismatch(descriptor)
    }
  }
}

/**
 * The caller must run `assertOrcadMigrationBlobsReady` first, in the same synchronous turn: that
 * pass hashes every staged file, and no chunk can land between it and these links.
 */
export function commitOrcadMigrationBlobs(manifest: OrcadMigrationManifest, root: string): void {
  const directories = new Set<string>()
  for (const descriptor of stagedBlobDescriptors(root, manifest)) {
    const finalPath = getOrcadMigrationReceivedBlobPath(root, manifest, descriptor)
    ensureOrcadMigrationDirectory(dirname(finalPath))
    linkOrcadMigrationStagedFile({
      stagedPath: stagedBlobPath(root, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `orcad_migration_blob_destination_conflict:${descriptor.blobKind}:${descriptor.key}`
    })
    directories.add(dirname(finalPath))
  }
  for (const directory of directories) {
    syncDirectoryDurablySync(directory)
  }
  removeOrcadMigrationStagingDirectory(root, manifest)
}

/** Also drops blobs a failed commit already moved: the catalog they belonged to never landed. */
export function abortOrcadMigrationBlobs(manifest: OrcadMigrationManifest, root: string): void {
  removeOrcadMigrationStagingDirectory(root, manifest)
  rmSync(receivedBlobsDirectory(root, manifest), { recursive: true, force: true })
}

/** Received blobs stay only for staged or committed migrations; a failed commit's are dropped. */
export function pruneOrcadMigrationBlobStaging(
  stagedManifests: readonly OrcadMigrationManifest[],
  committedMigrations: readonly OrcadMigrationRequestIdentity[],
  root: string
): void {
  pruneOrcadMigrationStagingDirectories(root, stagedManifests)
  pruneOrcadMigrationKeyedDirectories(join(root, RECEIVED_DIRECTORY), [
    ...stagedManifests,
    ...committedMigrations
  ])
}

function blobSetMismatch(descriptor: OrcadMigrationBlobDescriptor): Error {
  return new Error(`orcad_migration_blob_set_mismatch:${descriptor.blobKind}:${descriptor.key}`)
}

function receivedBlobIdentities(root: string, manifest: OrcadMigrationManifest): string[] {
  const received = receivedBlobsDirectory(root, manifest)
  return ORCAD_MIGRATION_BLOB_KINDS.flatMap((blobKind) =>
    readDirectory(join(received, blobKind)).map((key) =>
      orcadMigrationBlobIdentity({ blobKind, key })
    )
  )
}

function stagedBlobDescriptors(
  root: string,
  manifest: OrcadMigrationManifest
): OrcadMigrationBlobDescriptor[] {
  const staging = orcadMigrationStagingDirectory(root, manifest)
  const descriptors: OrcadMigrationBlobDescriptor[] = []
  for (const blobKind of ORCAD_MIGRATION_BLOB_KINDS) {
    for (const name of readDirectory(join(staging, blobKind))) {
      const match = STAGED_BLOB_NAME.exec(name)
      if (!match) {
        continue
      }
      try {
        descriptors.push(
          parseOrcadMigrationBlobDescriptor({
            blobKind,
            key: match[1],
            sha256: match[2],
            byteLength: Number(match[3])
          })
        )
      } catch {
        // Not a name this channel writes; it cannot belong to the staged set.
      }
    }
  }
  return descriptors
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function inspectReceivedBlob(
  root: string,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationBlobDescriptor
): 'absent' | 'matching' | 'conflict' {
  return inspectOrcadMigrationFinalFile(
    getOrcadMigrationReceivedBlobPath(root, manifest, descriptor),
    descriptor
  )
}

function receivedBlobsDirectory(root: string, manifest: OrcadMigrationRequestIdentity): string {
  return join(root, RECEIVED_DIRECTORY, orcadMigrationStagingKey(manifest))
}

function stagedBlobPath(
  root: string,
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationBlobDescriptor
): string {
  return join(
    orcadMigrationStagingDirectory(root, manifest),
    descriptor.blobKind,
    `${descriptor.key}.${descriptor.sha256}.${descriptor.byteLength}.part`
  )
}
