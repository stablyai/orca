import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcadMigrationBlobDescriptor } from '../shared/orcad-migration/orcad-migration-blob-transfer'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import { manifest } from './persistence-orcad-migration-catalog-fixture'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

// A kind with no installer yet, so the channel's own behaviour is all that runs.
const bytes = Buffer.from('session record one\nsession record two\n')
const blob: OrcadMigrationBlobDescriptor = {
  blobKind: 'agent-session-records',
  key: 'session-kept',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: bytes.length
}

function chunk(input: ReturnType<typeof manifest>, offset: number, end: number) {
  return {
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    blob,
    offset,
    bytesBase64: bytes.subarray(offset, end).toString('base64')
  }
}

function blobRoot(): string {
  return join(testState.dir, 'orcad-migration-blobs')
}

describe('orcad migration blobs through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-blobs-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reports staged progress across a restart and refuses commit until complete', async () => {
    const input = manifest()
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    expect(store.getOrcadMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
    store.stageOrcadMigrationBlobChunk(chunk(input, 0, 8))

    const restarted = createStore()
    expect(restarted.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob, receivedBytes: 8 }]
    })
    expect(() => restarted.commitStagedOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_blob_incomplete:agent-session-records:${blob.key}`
    )
    expect(restarted.getOrcadMigrationCatalogState(input).state).toBe('staged')

    restarted.stageOrcadMigrationBlobChunk(chunk(input, 8, bytes.length))
    expect(restarted.commitStagedOrcadMigrationCatalog(input).state).toBe('committed')
    expect(readFileSync(getOrcadMigrationReceivedBlobPath(blobRoot(), input, blob))).toEqual(bytes)
  })

  it('commits only the blob set the sender names, and checks nothing when it names none', () => {
    const input = manifest()
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    store.stageOrcadMigrationBlobChunk(chunk(input, 0, bytes.length))
    const missing: OrcadMigrationBlobDescriptor = {
      blobKind: 'agent-session-records',
      key: 'session-lost',
      sha256: 'e'.repeat(64),
      byteLength: 4
    }

    expect(() =>
      store.commitStagedOrcadMigrationCatalog(input, {
        expectedBlobs: [blob, missing]
      })
    ).toThrow('orcad_migration_blob_set_mismatch:agent-session-records:session-lost')
    expect(() => store.commitStagedOrcadMigrationCatalog(input, { expectedBlobs: [] })).toThrow(
      `orcad_migration_blob_set_mismatch:agent-session-records:${blob.key}`
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
    expect(store.commitStagedOrcadMigrationCatalog(input, { expectedBlobs: [blob] }).state).toBe(
      'committed'
    )
  })

  it('removes staged blobs when the catalog is aborted', () => {
    const input = manifest()
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    store.stageOrcadMigrationBlobChunk(chunk(input, 0, 8))

    expect(store.abortStagedOrcadMigrationCatalog(input)).toMatchObject({ aborted: true })
    expect(() => store.stageOrcadMigrationBlobChunk(chunk(input, 8, bytes.length))).toThrow(
      'orcad_migration_blob_catalog_not_staged'
    )
    store.stageOrcadMigrationCatalog(input)
    expect(store.getOrcadMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
  })
})
