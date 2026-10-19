import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcadMigrationManifest } from '../shared/orcad-migration/orcad-migration-manifest'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  commitStagedOrcadMigrationCatalogDurably,
  getOrcadMigrationCatalogState
} from './runtime/orcad-migration-catalog-import'
import {
  DRAFT_A,
  FILE_A,
  HINTED_PANE,
  commitDurably,
  declaredManifest,
  draftOf,
  encodeDrafts,
  encodeHints,
  openFile,
  receivedDraftsPath,
  stageBlob,
  type Store
} from './persistence-orcad-migration-editor-drafts-fixture'
import {
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

const noLiveShells = (): boolean => false

function receivedHintsPath(input: OrcadMigrationManifest): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'terminal-restore-hints',
    key: 'migration'
  })
}

function hint(store: Store): string | null {
  return store.peekOrcadMigrationTerminalRestoreHint(HINTED_PANE, DORMANT_WORKTREE_ID)
}

/** Drafts plus restore hints staged and durable; returns the disk state before any commit. */
async function stageDraftsAndHints(store: Store) {
  const drafts = encodeDrafts([DRAFT_A])
  const hints = encodeHints('/home/me/src')
  const input = declaredManifest(drafts.descriptor)
  store.stageOrcadMigrationCatalog(input)
  stageBlob(store, input, drafts)
  stageBlob(store, input, hints)
  await store.flushPendingOrThrowAsync()
  return { input, expectedBlobs: [drafts.descriptor, hints.descriptor], stagedDisk: readDataFile() }
}

async function commitWithFailedFlush(store: Store, input: OrcadMigrationManifest) {
  vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))
  await expect(commitDurably(store, input)).rejects.toThrow('disk full')
}

describe('orcad migration received blobs wait for a durable commit', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-drafts-durable-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps every received blob through a failed flush and a state query, for the retry after restart', async () => {
    const store = createStore()
    const { input, expectedBlobs, stagedDisk } = await stageDraftsAndHints(store)
    await commitWithFailedFlush(store, input)

    // The in-memory receipt answers "committed", but nothing it received may be consumed yet.
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedDraftsPath(input))).toBe(true)
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
    expect(draftOf(restarted, FILE_A)).toBe(DRAFT_A.content)
    expect(hint(restarted)).toBe('/home/me/src')
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(existsSync(receivedHintsPath(input))).toBe(false)
  })

  it('never consumes an in-memory-only commit in the post-attach pass', async () => {
    const store = createStore()
    const { input } = await stageDraftsAndHints(store)
    await commitWithFailedFlush(store, input)

    store.installPendingOrcadMigrationReceivedBlobs({ worktreeHasLiveShells: noLiveShells })
    store.installDeferredOrcadMigrationShellHistory(DORMANT_WORKTREE_ID, {
      worktreeHasLiveShells: noLiveShells
    })
    expect(existsSync(receivedDraftsPath(input))).toBe(true)
    expect(existsSync(receivedHintsPath(input))).toBe(true)
  })

  it('releases the blobs when a same-process retry flushes the commit', async () => {
    const store = createStore()
    const { input, expectedBlobs } = await stageDraftsAndHints(store)
    await commitWithFailedFlush(store, input)

    const retried = await commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: input,
      expectedBlobs,
      onDurableCommit: () => {}
    })
    expect(retried.state).toBe('committed')
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(existsSync(receivedHintsPath(input))).toBe(false)
    expect(hint(store)).toBe('/home/me/src')
    expect(draftOf(createStore(), FILE_A)).toBe(DRAFT_A.content)
  })

  it('treats any successful write of the commit as proof, and a load from disk as proof', async () => {
    const store = createStore()
    const { input } = await stageDraftsAndHints(store)
    store.commitStagedOrcadMigrationCatalog(input)
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedDraftsPath(input))).toBe(true)
    await store.flushPendingOrThrowAsync()

    const restarted = createStore()
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(existsSync(receivedHintsPath(input))).toBe(false)
    expect(draftOf(restarted, FILE_A)).toBe(DRAFT_A.content)
    expect(hint(restarted)).toBe('/home/me/src')
  })

  it('commits an older desktop inline draft unchanged', async () => {
    const dormant = dormantState()
    dormant.workspaceSession = {
      ...dormant.workspaceSession!,
      openFilesByWorktree: { [DORMANT_WORKTREE_ID]: [openFile(FILE_A, DRAFT_A.content)] }
    }
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormant } })
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)

    expect((await commitDurably(store, input)).state).toBe('committed')
    expect(draftOf(createStore(), FILE_A)).toBe(DRAFT_A.content)
  })
})
