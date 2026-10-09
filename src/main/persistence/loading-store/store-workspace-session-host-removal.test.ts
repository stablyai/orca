import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const REMOVED = 'runtime:removed-env'
const KEPT = 'runtime:kept-env'
const stores: InstanceType<typeof Store>[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
})

function createStore(dataFile: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

function session(worktreeId: string): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the partition's presence is asserted.
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: worktreeId,
    activeTabId: 'tab-1',
    tabsByWorktree: { [worktreeId]: [{ id: 'tab-1', worktreeId }] },
    terminalLayoutsByTabId: {}
  } as unknown as WorkspaceSessionState
}

describe('removing a host’s workspace session partition', () => {
  it('drops only that host, keeps local, and stays dropped after a reload', async () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-removal-'))),
      'orca-data.json'
    )
    const store = createStore(dataFile)
    store.setWorkspaceSession(session('repo-1::/a'), REMOVED)
    store.setWorkspaceSession(session('repo-1::/b'), KEPT)
    expect(store.getWorkspaceSessionHostIds()).toEqual(expect.arrayContaining([REMOVED, KEPT]))

    store.removeWorkspaceSessionHost(REMOVED)
    store.removeWorkspaceSessionHost('local')

    expect(store.getWorkspaceSessionHostIds()).not.toContain(REMOVED)
    expect(store.getWorkspaceSessionHostIds()).toEqual(expect.arrayContaining(['local', KEPT]))
    store.flush()
    store.freezeWrites()

    const reloaded = createStore(dataFile)
    expect(reloaded.getWorkspaceSessionHostIds()).not.toContain(REMOVED)
    expect(reloaded.getWorkspaceSessionHostIds()).toContain(KEPT)
  })
})
