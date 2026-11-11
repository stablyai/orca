import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistoryMeta } from '../../../pty/history/terminal-history'
import { getHistoryRoot } from '../../../pty/history/terminal-history-paths'
import {
  DORMANT_WORKTREE_ID,
  manifest
} from '../catalog-commit/persistence-orcad-migration-catalog-fixture'
import {
  BASH,
  ZSH,
  commitDurably,
  encodedHistories as encodeFrom,
  hostHistory,
  hostHistoryDirectory,
  noLiveShells,
  receivedPath,
  stage,
  type EncodedBlob
} from './persistence-orcad-migration-shell-history-fixture'
import { createStore, testState } from '../../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

let desktopHistory: string

// Pin bash because lone WSL history follows the host’s resolved pane shell.
function bashHostStore(): ReturnType<typeof createStore> {
  return createStore({ paneShellPath: () => '/bin/bash' })
}

function encodedHistories(
  files: { worktreeId: string; file: string; content: string }[]
): Promise<EncodedBlob[]> {
  return encodeFrom(desktopHistory, files)
}

describe('orcad migration shell history through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-shell-history-'))
    desktopHistory = mkdtempSync(join(tmpdir(), 'orca-desktop-history-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(desktopHistory, { recursive: true, force: true })
    rmSync(getHistoryRoot(), { recursive: true, force: true })
  })

  it('refuses before commit a history whose worktree the catalog does not move', async () => {
    const input = manifest()
    const store = bashHostStore()
    stage(
      store,
      input,
      await encodedHistories([
        { worktreeId: 'repo-other::/srv/other', file: 'zsh_history', content: ZSH }
      ])
    )

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_blob_content_invalid:shell-history:orcad_migration_shell_history_worktree_not_migrated'
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
    expect(existsSync(getHistoryRoot())).toBe(false)
  })

  it('keeps existing host history after the moved lines, and is idempotent on a retry', async () => {
    const input = manifest()
    const store = bashHostStore()
    const blobs = await encodedHistories([
      { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content: ': 1:0;moved' }
    ])
    stage(store, input, blobs)
    const directory = hostHistoryDirectory(DORMANT_WORKTREE_ID)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'zsh_history'), ': 2:0;host\n')
    writeFileSync(
      join(directory, 'meta.json'),
      JSON.stringify({ worktreeId: DORMANT_WORKTREE_ID, createdAt: 'then' })
    )

    expect(await commitDurably(store, input)).toBe('committed')
    const merged = ': 1:0;moved\n: 2:0;host\n'
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(merged)
    expect(readHistoryMeta(directory)?.createdAt).toBe('then')

    // Simulate a crash after installation but before deleting the received blob.
    const [blob] = blobs
    writeFileSync(receivedPath(input, blob.descriptor.key), blob.bytes)
    expect(await commitDurably(bashHostStore(), input)).toBe('committed')
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(merged)
    expect(existsSync(receivedPath(input, blob.descriptor.key))).toBe(false)
  })

  it('leaves history to the post-attach pass at store load, which still waits on live shells', async () => {
    const input = manifest()
    const store = bashHostStore()
    const blobs = await encodedHistories([
      { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content: BASH }
    ])
    stage(store, input, blobs)
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()

    const reloaded = bashHostStore()
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    expect(existsSync(receivedPath(input, blobs[0].descriptor.key))).toBe(true)
    expect(reloaded.hasPendingOrcadMigrationShellHistory()).toBe(true)

    reloaded.installPendingOrcadMigrationReceivedBlobs({ worktreeHasLiveShells: () => true })
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    expect(reloaded.hasPendingOrcadMigrationShellHistory()).toBe(true)

    reloaded.installPendingOrcadMigrationReceivedBlobs({ worktreeHasLiveShells: noLiveShells })
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
    expect(existsSync(receivedPath(input, blobs[0].descriptor.key))).toBe(false)
    expect(reloaded.hasPendingOrcadMigrationShellHistory()).toBe(false)
  })
})
