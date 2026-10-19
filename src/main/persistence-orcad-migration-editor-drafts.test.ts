import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DRAFT_A,
  FILE_A,
  FILE_B,
  commitDurably,
  declaredManifest,
  draftOf,
  encodeDrafts,
  openFile,
  receivedDraftsPath,
  setDestinationFiles,
  stageBlob
} from './persistence-orcad-migration-editor-drafts-fixture'
import { DORMANT_WORKTREE_ID } from './persistence-orcad-migration-catalog-fixture'
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

describe('orcad migration editor drafts blob', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-drafts-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('applies an 8 MiB draft byte-identical inside the commit and releases the blob once durable', async () => {
    const content = `${'x'.repeat(8 * 1024 * 1024 - 7)}é\n\u0000end`
    const blob = encodeDrafts([{ ...DRAFT_A, content }])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect((await commitDurably(store, input)).state).toBe('committed')
    expect(draftOf(store, FILE_A)).toBe(content)
    expect(draftOf(store, FILE_B)).toBeUndefined()
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(draftOf(createStore(), FILE_A)).toBe(content)
  })

  it('refuses a declared blob that never arrived, whether or not the sender names its blobs', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_missing'
    )
    expect(() => store.commitStagedOrcadMigrationCatalog(input, { expectedBlobs: [] })).toThrow(
      'orcad_migration_editor_drafts_missing'
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
    expect(store.getRepos()).toEqual([])
  })

  it('refuses a drafts blob the manifest does not declare', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(null)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_undeclared'
    )
    expect(store.getRepos()).toEqual([])
  })

  it('refuses a draft for an entry the manifest did not shed', () => {
    const blob = encodeDrafts([
      DRAFT_A,
      { worktreeKey: DORMANT_WORKTREE_ID, filePath: FILE_B, content: 'extra' }
    ])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_set_mismatch'
    )
    expect(store.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob.descriptor, receivedBytes: blob.descriptor.byteLength }]
    })
  })

  it('refuses bytes whose digest differs from the signed declaration', () => {
    const declared = encodeDrafts([DRAFT_A])
    const sent = encodeDrafts([{ ...DRAFT_A, content: 'tampered' }])
    const input = declaredManifest(declared.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, sent)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_digest_mismatch'
    )
    expect(store.getRepos()).toEqual([])
  })

  it('accepts a destination entry already holding the identical draft', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, DRAFT_A.content), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(store.commitStagedOrcadMigrationCatalog(input).state).toBe('committed')
    expect(draftOf(store, FILE_A)).toBe(DRAFT_A.content)
  })

  it('stages past a competing destination draft but refuses it at commit, keeping staging', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, 'destination edit'), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:openFilesByWorktree:${DORMANT_WORKTREE_ID}`
    )
    expect(draftOf(store, FILE_A)).toBe('destination edit')
    expect(store.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob.descriptor, receivedBytes: blob.descriptor.byteLength }]
    })
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
  })

  it('refuses a destination draft edited between stage and commit', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, DRAFT_A.content), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    setDestinationFiles(store, [openFile(FILE_A, 'edited after staging'), openFile(FILE_B)])

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:openFilesByWorktree:${DORMANT_WORKTREE_ID}`
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })

  it('re-applies the received drafts on a retry after the first commit was lost', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    store.commitStagedOrcadMigrationCatalog(input)
    writeDataFile(stagedDiskState)

    // Staging is gone: the first commit moved the blob, so only the received bytes remain.
    const restarted = createStore()
    expect(restarted.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'staged' })
    expect(restarted.getOrcadMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
    expect(draftOf(restarted, FILE_A)).toBeUndefined()
    expect((await commitDurably(restarted, input)).state).toBe('committed')
    expect(draftOf(restarted, FILE_A)).toBe(DRAFT_A.content)
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
  })

  it('refuses a received-only retry whose bytes were damaged', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    store.commitStagedOrcadMigrationCatalog(input)
    writeDataFile(stagedDiskState)
    writeFileSync(receivedDraftsPath(input), Buffer.from('damaged'))

    const restarted = createStore()
    expect(() => restarted.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_digest_mismatch'
    )
    expect(restarted.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })
})
