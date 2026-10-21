import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ORCAD_MIGRATION_BLOB_CHUNK_BYTES,
  type OrcadMigrationBlobDescriptor
} from '../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../shared/orcad-migration/orcad-migration-manifest'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  commitStagedOrcadMigrationCatalogDurably,
  getOrcadMigrationCatalogState
} from './runtime/orcad-migration-catalog-import'
import {
  DORMANT_LEAF_ID,
  DORMANT_WORKTREE_ID,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'
import { createStore, readDataFile, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

type Store = ReturnType<typeof createStore>

const HINTED_PANE = `tab-dormant:${DORMANT_LEAF_ID}`
const noLiveShells = (): boolean => false

function encodeHints(cwd: string): { bytes: Buffer; descriptor: OrcadMigrationBlobDescriptor } {
  const bytes = Buffer.from(JSON.stringify({ version: 1, hints: [{ paneKey: HINTED_PANE, cwd }] }))
  return {
    bytes,
    descriptor: {
      blobKind: 'terminal-restore-hints',
      key: 'migration',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

function receivedHintsPath(input: OrcadMigrationManifest): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'terminal-restore-hints',
    key: 'migration'
  })
}

function hint(store: Store): string | null {
  return store.peekOrcadMigrationTerminalRestoreHint(HINTED_PANE, DORMANT_WORKTREE_ID)
}

function commitDurably(store: Store, input: OrcadMigrationManifest) {
  return commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    onDurableCommit: () => {}
  })
}

/** Restore hints staged and durable; returns the disk state before any commit. */
async function stageHints(store: Store) {
  const hints = encodeHints('/home/me/src')
  const base = manifest()
  const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
  store.stageOrcadMigrationCatalog(input)
  for (let offset = 0; offset < hints.bytes.length; offset += ORCAD_MIGRATION_BLOB_CHUNK_BYTES) {
    store.stageOrcadMigrationBlobChunk({
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      blob: hints.descriptor,
      offset,
      bytesBase64: hints.bytes
        .subarray(offset, offset + ORCAD_MIGRATION_BLOB_CHUNK_BYTES)
        .toString('base64')
    })
  }
  await store.flushPendingOrThrowAsync()
  return { input, expectedBlobs: [hints.descriptor], stagedDisk: readDataFile() }
}

async function commitWithFailedFlush(store: Store, input: OrcadMigrationManifest) {
  vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))
  await expect(commitDurably(store, input)).rejects.toThrow('disk full')
}

describe('orcad migration received blobs wait for a durable commit', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-blobs-durable-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the received blob through a failed flush and a state query, for the retry after restart', async () => {
    const store = createStore()
    const { input, expectedBlobs, stagedDisk } = await stageHints(store)
    await commitWithFailedFlush(store, input)

    // The in-memory receipt answers "committed", but nothing it received may be consumed yet.
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedHintsPath(input))).toBe(true)
    expect(hint(store)).toBeNull()

    writeDataFile(stagedDisk)
    const restarted = createStore()
    expect(restarted.getOrcadMigrationCatalogState(input).state).toBe('staged')
    const result = await commitStagedOrcadMigrationCatalogDurably({
      store: restarted,
      manifest: input,
      expectedBlobs,
      onDurableCommit: () => {}
    })
    expect(result.state).toBe('committed')
    expect(hint(restarted)).toBe('/home/me/src')
    expect(existsSync(receivedHintsPath(input))).toBe(false)
  })

  it('never consumes an in-memory-only commit in the post-attach pass', async () => {
    const store = createStore()
    const { input } = await stageHints(store)
    await commitWithFailedFlush(store, input)

    store.installPendingOrcadMigrationReceivedBlobs({ worktreeHasLiveShells: noLiveShells })
    store.installDeferredOrcadMigrationShellHistory(DORMANT_WORKTREE_ID, {
      worktreeHasLiveShells: noLiveShells
    })
    expect(existsSync(receivedHintsPath(input))).toBe(true)
  })

  it('installs the blob when a same-process retry flushes the commit', async () => {
    const store = createStore()
    const { input, expectedBlobs } = await stageHints(store)
    await commitWithFailedFlush(store, input)

    const retried = await commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: input,
      expectedBlobs,
      onDurableCommit: () => {}
    })
    expect(retried.state).toBe('committed')
    expect(existsSync(receivedHintsPath(input))).toBe(false)
    expect(hint(store)).toBe('/home/me/src')
  })

  it('treats any successful write of the commit as proof, and a load from disk as proof', async () => {
    const store = createStore()
    const { input } = await stageHints(store)
    store.commitStagedOrcadMigrationCatalog(input)
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedHintsPath(input))).toBe(true)
    await store.flushPendingOrThrowAsync()

    const restarted = createStore()
    expect(existsSync(receivedHintsPath(input))).toBe(false)
    expect(hint(restarted)).toBe('/home/me/src')
  })
})
