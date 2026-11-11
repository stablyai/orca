import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_BLOB_CHUNK_BYTES,
  requiredMigrationBlobCapabilities,
  type OrcadMigrationBlobDescriptor
} from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY } from '../../../../shared/orcad-runtime-capabilities'
import {
  inspectOrcadMigrationBlobUploads,
  stageOrcadMigrationBlobChunk
} from '../../../persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  transferOrcadMigrationBlobs,
  type OrcadMigrationBlobDestination
} from './orcad-migration-blob-coordinator'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-migration-blob-sender-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const manifest: OrcadMigrationManifest = {
  version: ORCAD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-1',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
  manifestSha256: 'a'.repeat(64)
}

const history = Buffer.alloc(ORCAD_MIGRATION_BLOB_CHUNK_BYTES * 2 + 17, 0x61)
const hints = Buffer.from('{"panes":[]}')
const blobs = [
  descriptor('shell-history', `${'a'.repeat(16)}-zsh`, history),
  descriptor('terminal-restore-hints', 'migration', hints)
]
const contents = new Map([
  [blobs[0].key, history],
  [blobs[1].key, hints]
])

describe('orcad migration blob sender', () => {
  it.each([
    ['the blob channel', [blobs[1]], ['orcad.migration-blob.terminal-restore-hints.v1']],
    ["the blob's kind", [blobs[1]], [ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY]]
  ])('refuses before staging anything when the destination lacks %s', async (_, sent, caps) => {
    const destination = realDestination(caps)

    await expect(
      transferOrcadMigrationBlobs({ source: source(), manifest, blobs: sent, destination })
    ).rejects.toThrow(/^orcad_migration_destination_blob_kind_unsupported:terminal-restore-hints:/)
    expect(destination.readState).not.toHaveBeenCalled()
    expect(destination.stageChunk).not.toHaveBeenCalled()
    expect(inspectOrcadMigrationBlobUploads(manifest, root)).toBeUndefined()
  })

  it('refuses when the destination holds the same key with other bytes', async () => {
    const stale = descriptor('terminal-restore-hints', 'migration', Buffer.from('stale'))
    stageOrcadMigrationBlobChunk({
      stagedManifest: manifest,
      root,
      request: chunkRequest(stale, 0, Buffer.from('st'))
    })
    const destination = realDestination(requiredMigrationBlobCapabilities(blobs))

    await expect(
      transferOrcadMigrationBlobs({ source: source(), manifest, blobs, destination })
    ).rejects.toThrow('orcad_migration_blob_descriptor_conflict:terminal-restore-hints')
    expect(destination.stageChunk).not.toHaveBeenCalled()
  })
})

function descriptor(
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

function chunkRequest(blob: OrcadMigrationBlobDescriptor, offset: number, bytes: Buffer) {
  return {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    blob,
    offset,
    bytesBase64: bytes.toString('base64')
  }
}

function source() {
  return {
    readChunk: async (blob: OrcadMigrationBlobDescriptor, offset: number, maxBytes: number) =>
      (contents.get(blob.key) ?? Buffer.alloc(0)).subarray(offset, offset + maxBytes)
  }
}

/** Use real staging semantics so resume observes host-equivalent state. */
function realDestination(capabilities: readonly string[]) {
  const readState = async (): Promise<OrcadMigrationCatalogState> => {
    const blobUploads = inspectOrcadMigrationBlobUploads(manifest, root)
    return {
      state: 'staged',
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      stagedAt: '2026-08-30T12:01:00.000Z',
      ...(blobUploads ? { blobUploads } : {})
    }
  }
  const destination = {
    readCapabilities: vi.fn<OrcadMigrationBlobDestination['readCapabilities']>(
      async () => capabilities
    ),
    readState: vi.fn<OrcadMigrationBlobDestination['readState']>(readState),
    stageChunk: vi.fn<OrcadMigrationBlobDestination['stageChunk']>(async (request) =>
      stageOrcadMigrationBlobChunk({ stagedManifest: manifest, root, request })
    )
  }
  return destination
}
