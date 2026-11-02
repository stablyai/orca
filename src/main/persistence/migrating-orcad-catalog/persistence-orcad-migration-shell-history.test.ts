import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeOrcadMigrationShellHistoryHeader } from './orcad-migration-shell-history-format'
import { getOrcadMigrationCatalogState } from '../../runtime/orcad-migration-catalog-import'
import { injectHistoryEnv, readHistoryMeta } from '../../terminal-history'
import { getHistoryRoot } from '../../terminal-history-paths'
import { hashWorktreeId } from '../../terminal-history-id'
import { DORMANT_WORKTREE_ID, manifest } from './persistence-orcad-migration-catalog-fixture'
import {
  BASH,
  FOLDER_KEY,
  ZSH,
  commitDurably,
  encodedHistories as encodeFrom,
  hostHistory,
  hostHistoryDirectory,
  noLiveShells,
  rawBlob,
  receivedPath,
  stage,
  type EncodedBlob
} from './persistence-orcad-migration-shell-history-fixture'
import { createStore, testState } from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

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

  it('installs each history and its meta.json where a new pane in that worktree reads it', async () => {
    const input = manifest()
    const store = bashHostStore()
    const blobs = await encodedHistories([
      { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content: ZSH },
      { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content: BASH },
      { worktreeId: FOLDER_KEY, file: 'bash_history', content: 'ls\n' }
    ])
    stage(store, input, blobs)

    expect(await commitDurably(store, input)).toBe('committed')

    for (const blob of blobs) {
      expect(existsSync(receivedPath(input, blob.descriptor.key))).toBe(false)
    }
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
    expect(hostHistory(FOLDER_KEY, 'bash_history')).toBe('ls\n')
    const directory = hostHistoryDirectory(DORMANT_WORKTREE_ID)
    expect(readHistoryMeta(directory)?.worktreeId).toBe(DORMANT_WORKTREE_ID)
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, 'zsh_history')).mode & 0o777).toBe(0o600)
    }

    for (const [shell, file] of [
      ['/bin/zsh', 'zsh_history'],
      ['/bin/bash', 'bash_history']
    ]) {
      const env: Record<string, string> = {}
      const injected = injectHistoryEnv(env, DORMANT_WORKTREE_ID, shell, '/srv/repo-1-worktree')
      expect(injected.histFile).toBe(join(directory, file))
    }
    expect(readHistoryMeta(directory)?.worktreeId).toBe(DORMANT_WORKTREE_ID)
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

  it('refuses before commit a header that does not match its key, an empty history, and fish', () => {
    const header = encodeOrcadMigrationShellHistoryHeader(DORMANT_WORKTREE_ID)
    const hash = hashWorktreeId(DORMANT_WORKTREE_ID)
    const cases: [EncodedBlob, string][] = [
      [
        rawBlob(`${hashWorktreeId(FOLDER_KEY)}-zsh`, Buffer.concat([header, Buffer.from(ZSH)])),
        'orcad_migration_shell_history_key_mismatch'
      ],
      [rawBlob(`${hash}-zsh`, header), 'orcad_migration_shell_history_empty'],
      [
        rawBlob(`${hash}-fish`, Buffer.concat([header, Buffer.from('- cmd: ls\n')])),
        'orcad_migration_shell_history_shell_unsupported'
      ],
      [
        rawBlob(`${hash}-bash`, Buffer.from('no header\n')),
        'orcad_migration_shell_history_header_invalid'
      ]
    ]
    for (const [blob, reason] of cases) {
      const input = manifest({ migrationId: `migration-${blob.descriptor.key}` })
      const store = bashHostStore()
      stage(store, input, [blob])
      expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
        `orcad_migration_blob_content_invalid:shell-history:${reason}`
      )
    }
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

  it('retries a failed install on a catalog-state query, not at store load', async () => {
    const input = manifest()
    const store = bashHostStore()
    const blobs = await encodedHistories([
      { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content: ZSH },
      { worktreeId: FOLDER_KEY, file: 'bash_history', content: BASH }
    ])
    stage(store, input, blobs)
    // Block one history directory with a file to force an installation error.
    mkdirSync(getHistoryRoot(), { recursive: true })
    writeFileSync(hostHistoryDirectory(DORMANT_WORKTREE_ID), '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await commitDurably(store, input)).toBe('committed')
    expect(error).toHaveBeenCalledWith(
      '[orcad-migration] installing received blobs failed:',
      expect.any(Error)
    )
    expect(hostHistory(FOLDER_KEY, 'bash_history')).toBe(BASH)
    const pendingKey = `${hashWorktreeId(DORMANT_WORKTREE_ID)}-zsh`
    expect(existsSync(receivedPath(input, pendingKey))).toBe(true)

    bashHostStore()
    expect(existsSync(receivedPath(input, pendingKey))).toBe(true)
    error.mockRestore()

    rmSync(hostHistoryDirectory(DORMANT_WORKTREE_ID))
    // Loading has no live-shell inventory; installation must wait for a runtime-driven retry.
    bashHostStore()
    expect(existsSync(receivedPath(input, pendingKey))).toBe(true)
    expect(
      getOrcadMigrationCatalogState({
        store,
        manifest: input,
        worktreeHasLiveShells: noLiveShells
      }).state
    ).toBe('committed')
    expect(existsSync(receivedPath(input, pendingKey))).toBe(false)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
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

  it('reports nothing pending on a host that never received a migration', () => {
    expect(bashHostStore().hasPendingOrcadMigrationShellHistory()).toBe(false)
  })
})
