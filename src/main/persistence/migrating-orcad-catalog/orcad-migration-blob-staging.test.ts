import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  assertOrcadMigrationBlobsReady,
  commitOrcadMigrationBlobs,
  getOrcadMigrationReceivedBlobPath,
  inspectOrcadMigrationBlobUploads,
  stageOrcadMigrationBlobChunk
} from './orcad-migration-blob-staging'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-migration-blobs-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('orcad migration blob staging', () => {
  it('stages, reloads progress from disk, and accepts only exact retries', () => {
    const bytes = Buffer.from('echo one\necho two 🐋\n', 'utf8')
    const descriptor = blob('shell-history', `${'a'.repeat(16)}-zsh`, bytes)
    const manifest = migrationManifest('resume')
    const first = bytes.subarray(0, 9)

    expect(stage(manifest, descriptor, 0, first).receivedBytes).toBe(first.length)
    // Restart recovery must depend only on the directory.
    expect(inspectOrcadMigrationBlobUploads(manifest, root)).toEqual([
      { ...descriptor, receivedBytes: first.length }
    ])
    expect(stage(manifest, descriptor, 0, first).receivedBytes).toBe(first.length)
    expect(() => stage(manifest, descriptor, 0, Buffer.from('different'))).toThrow(
      'orcad_migration_blob_retry_mismatch'
    )
    expect(() => stage(manifest, descriptor, first.length + 1, Buffer.from('x'))).toThrow(
      'orcad_migration_blob_offset_invalid'
    )
    expect(() => stage(manifest, descriptor, first.length, bytes)).toThrow(
      'orcad_migration_blob_offset_invalid'
    )
    stage(manifest, descriptor, first.length, bytes.subarray(first.length))

    assertOrcadMigrationBlobsReady(manifest, root)
    commitOrcadMigrationBlobs(manifest, root)
    expect(readFileSync(getOrcadMigrationReceivedBlobPath(root, manifest, descriptor))).toEqual(
      bytes
    )
    expect(inspectOrcadMigrationBlobUploads(manifest, root)).toBeUndefined()
  })

  it('refuses commit while a blob is incomplete or its bytes do not match the digest', () => {
    const bytes = Buffer.from('expected bytes')
    const descriptor = blob('shell-history', `${'b'.repeat(16)}-bash`, bytes)
    const manifest = migrationManifest('refuse')

    stage(manifest, descriptor, 0, bytes.subarray(0, 4))
    expect(() => assertOrcadMigrationBlobsReady(manifest, root)).toThrow(
      `orcad_migration_blob_incomplete:shell-history:${descriptor.key}`
    )
    stage(manifest, descriptor, 4, Buffer.alloc(bytes.length - 4, 0x78))
    expect(() => assertOrcadMigrationBlobsReady(manifest, root)).toThrow(
      'orcad_migration_blob_digest_mismatch'
    )
    expect(existsSync(getOrcadMigrationReceivedBlobPath(root, manifest, descriptor))).toBe(false)
  })

  it('treats a matching received file as done and a different one as a conflict', () => {
    const bytes = Buffer.from('hints')
    const descriptor = blob('terminal-restore-hints', 'migration', bytes)
    const manifest = migrationManifest('received')
    stage(manifest, descriptor, 0, bytes)
    const finalPath = getOrcadMigrationReceivedBlobPath(root, manifest, descriptor)
    mkdirSync(dirname(finalPath), { recursive: true })
    writeFileSync(finalPath, 'other')

    expect(() => commitOrcadMigrationBlobs(manifest, root)).toThrow(
      'orcad_migration_blob_destination_conflict:terminal-restore-hints:migration'
    )
    writeFileSync(finalPath, bytes)
    assertOrcadMigrationBlobsReady(manifest, root)
    commitOrcadMigrationBlobs(manifest, root)
    expect(readFileSync(finalPath)).toEqual(bytes)
  })
})

function blob(
  blobKind: OrcadMigrationBlobDescriptor['blobKind'],
  key: string,
  bytes: Buffer
): OrcadMigrationBlobDescriptor {
  return {
    blobKind,
    key,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
}

function migrationManifest(migrationId: string): OrcadMigrationManifest {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: 'a'.repeat(64)
  }
}

function request(
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationBlobDescriptor,
  offset: number,
  bytes: Buffer
) {
  return {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    blob: descriptor,
    offset,
    bytesBase64: bytes.toString('base64')
  }
}

function stage(
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationBlobDescriptor,
  offset: number,
  bytes: Buffer
) {
  return stageOrcadMigrationBlobChunk({
    stagedManifest: manifest,
    root,
    request: request(manifest, descriptor, offset, bytes)
  })
}
