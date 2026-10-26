import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitStagedOrcadMigrationCatalogDurably } from '../../runtime/orcad-migration-catalog-import'
import { readHistoryMeta } from '../../terminal-history'
import { getHistoryRoot } from '../../terminal-history-paths'
import { DORMANT_WORKTREE_ID, manifest } from './persistence-orcad-migration-catalog-fixture'
import {
  ZSH,
  encodedHistories,
  hostHistory,
  hostHistoryDirectory,
  noLiveShells,
  receivedPath,
  stage
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

function zshHostStore(): ReturnType<typeof createStore> {
  return createStore({ paneShellPath: () => '/usr/bin/zsh' })
}

async function stageZsh(
  store: ReturnType<typeof createStore>,
  content: string
): Promise<{ input: ReturnType<typeof manifest>; key: string; bytes: Buffer }> {
  const input = manifest()
  const [blob] = await encodedHistories(desktopHistory, [
    { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content }
  ])
  stage(store, input, [blob])
  return { input, key: blob.descriptor.key, bytes: blob.bytes }
}

describe('installing moved shell history safely', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-history-safety-'))
    desktopHistory = mkdtempSync(join(tmpdir(), 'orca-desktop-history-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(desktopHistory, { recursive: true, force: true })
    rmSync(getHistoryRoot(), { recursive: true, force: true })
  })

  it('waits while a shell runs in the worktree and installs once the last one exits', async () => {
    const store = zshHostStore()
    const { input, key } = await stageZsh(store, ZSH)
    let live = true
    const worktreeHasLiveShells = (worktreeId: string): boolean =>
      live && worktreeId === DORMANT_WORKTREE_ID

    const result = await commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: input,
      worktreeHasLiveShells,
      onDurableCommit: () => {}
    })

    expect(result.state).toBe('committed')
    expect(existsSync(hostHistoryDirectory(DORMANT_WORKTREE_ID))).toBe(false)
    expect(existsSync(receivedPath(input, key))).toBe(true)

    store.installDeferredOrcadMigrationShellHistory('repo-other::/srv/other', {
      worktreeHasLiveShells
    })
    expect(existsSync(receivedPath(input, key))).toBe(true)

    live = false
    store.installDeferredOrcadMigrationShellHistory(DORMANT_WORKTREE_ID, { worktreeHasLiveShells })
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(existsSync(receivedPath(input, key))).toBe(false)
  })

  it('records the installed blob, so a retry after a shell trimmed the file never re-prepends', async () => {
    const store = zshHostStore()
    const { input, key, bytes } = await stageZsh(store, ZSH)
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    store.installOrcadMigrationReceivedBlobs(input, { worktreeHasLiveShells: noLiveShells })
    const directory = hostHistoryDirectory(DORMANT_WORKTREE_ID)
    expect(readHistoryMeta(directory)).toMatchObject({
      worktreeId: DORMANT_WORKTREE_ID,
      installedMigrationBlobs: [{ shell: 'zsh' }]
    })

    // HISTSIZE trimmed the file, then a crash left the received blob behind.
    writeFileSync(join(directory, 'zsh_history'), ': 9:0;newest\n')
    writeFileSync(receivedPath(input, key), bytes)
    createStore({ paneShellPath: () => '/bin/bash' }).installPendingOrcadMigrationReceivedBlobs({
      worktreeHasLiveShells: noLiveShells
    })

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(': 9:0;newest\n')
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    expect(existsSync(receivedPath(input, key))).toBe(false)
  })

  it('ends the moved history with a newline before it lands', async () => {
    const store = zshHostStore()
    const { input } = await stageZsh(store, ': 1:0;no newline')
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    store.installOrcadMigrationReceivedBlobs(input, { worktreeHasLiveShells: noLiveShells })

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(': 1:0;no newline\n')
  })

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked history file and keeps the link',
    async () => {
      const store = zshHostStore()
      const { input } = await stageZsh(store, ZSH)
      const target = join(testState.dir, 'dotfiles-zsh_history')
      writeFileSync(target, ': 2:0;host\n')
      const directory = hostHistoryDirectory(DORMANT_WORKTREE_ID)
      mkdirSync(directory, { recursive: true })
      const link = join(directory, 'zsh_history')
      symlinkSync(target, link)

      store.commitStagedOrcadMigrationCatalog(input)
      await store.flushPendingOrThrowAsync()
      store.installOrcadMigrationReceivedBlobs(input, { worktreeHasLiveShells: noLiveShells })

      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe(`${ZSH}: 2:0;host\n`)
    }
  )
})
