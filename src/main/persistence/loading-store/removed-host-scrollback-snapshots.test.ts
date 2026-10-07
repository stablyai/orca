import { createSqliteTestStore, readPersistedStateJson } from '../../persistence-test-harness'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  writeTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'

const { appPaths } = vi.hoisted(() => ({ appPaths: { userData: '' } }))
vi.mock('electron', () => ({
  app: {
    getPath: () => appPaths.userData || tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on() {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')
const leafId = '33333333-3333-4333-8333-333333333333'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-retired-snapshots-'))
  appPaths.userData = dir
  const dataFile = join(dir, 'profile', 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(dataFile)
  cleanups.push(async () => {
    store.freezeWrites()
    await store.waitForPendingWrite()
    rmSync(dir, { force: true, recursive: true })
  })
  function snapshot(tabId: string, root = snapshotRoot) {
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId,
      leafId,
      buffer: `scrollback for ${tabId}`,
      storage: { snapshotRoot: root }
    })
    if (!ref) {
      throw new Error('Snapshot fixture could not be written')
    }
    return { ref, path: join(root, `${ref}.bin`) }
  }
  return { dir, dataFile, store, snapshot }
}

function session(tabId: string, ref: string): WorkspaceSessionState {
  const worktreeId = 'remote-repo::/project'
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: tabId,
          worktreeId,
          ptyId: null,
          title: 'Remote',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [leafId]: ref }
      }
    }
  }
}

describe('removed runtime host scrollback files', () => {
  it('removes only the retired host snapshot after persisting its removal', async () => {
    const { dataFile, store, snapshot } = fixture()
    const removed = snapshot('removed')
    const untouched = snapshot('untouched')
    store.setWorkspaceSession(session('removed', removed.ref), 'runtime:removed')
    store.setWorkspaceSession(session('untouched', untouched.ref), 'runtime:untouched')
    store.flushOrThrow()
    expect(await store.removeRuntimeWorkspaceSessionPartition('runtime:removed')).toBe(true)
    expect(
      JSON.parse(readPersistedStateJson(dataFile)).workspaceSessionsByHostId
    ).not.toHaveProperty('runtime:removed')
    expect(existsSync(removed.path)).toBe(false)
    expect(store.readTerminalScrollbackSnapshot(untouched.ref)).toBe('scrollback for untouched')
  })

  it.each(['local', 'ssh:remaining', 'runtime:remaining'] as const)(
    'preserves a snapshot still referenced by %s',
    async (hostId) => {
      const { store, snapshot } = fixture()
      const shared = snapshot('shared')
      store.setWorkspaceSession(session('shared', shared.ref), hostId)
      store.setWorkspaceSession(session('shared', shared.ref), 'runtime:removed')
      expect(await store.removeRuntimeWorkspaceSessionPartition('runtime:removed')).toBe(true)
      expect(store.readTerminalScrollbackSnapshot(shared.ref)).toBe('scrollback for shared')
      expect(
        store.getWorkspaceSession(hostId).terminalLayoutsByTabId.shared.scrollbackRefsByLeafId
      ).toEqual({ [leafId]: shared.ref })
    }
  )

  it('preserves the active partition and snapshot when writes are frozen', async () => {
    const { store, snapshot } = fixture()
    const removed = snapshot('removed')
    store.setWorkspaceSession(session('removed', removed.ref), 'runtime:removed')
    store.flushOrThrow()
    store.freezeWrites()
    await expect(store.removeRuntimeWorkspaceSessionPartition('runtime:removed')).rejects.toThrow()
    expect(store.getWorkspaceSessionHostIds()).toContain('runtime:removed')
    expect(existsSync(removed.path)).toBe(true)
  })

  it('does not remove shared legacy fallback files', async () => {
    const { dir, store, snapshot } = fixture()
    const legacy = snapshot('legacy', join(dir, 'terminal-scrollback'))
    store.setWorkspaceSession(session('legacy', legacy.ref), 'runtime:removed')
    await store.removeRuntimeWorkspaceSessionPartition('runtime:removed')
    expect(existsSync(legacy.path)).toBe(true)
  })

  it.each(['local', 'ssh:remaining'] as const)('refuses to remove %s', async (hostId) => {
    const { store, snapshot } = fixture()
    const retained = snapshot('retained')
    store.setWorkspaceSession(session('retained', retained.ref), hostId)
    expect(await store.removeRuntimeWorkspaceSessionPartition(hostId)).toBe(false)
    expect(existsSync(retained.path)).toBe(true)
  })
})
