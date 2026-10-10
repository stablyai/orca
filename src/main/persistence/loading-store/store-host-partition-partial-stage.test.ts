import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
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

const HOST_ID = 'runtime:env-1'
const WT = 'repo-1::/tmp/worktree-a'

const stores: InstanceType<typeof Store>[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
})

function createStore(): InstanceType<typeof Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-store-host-partial-stage-')))
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'orca-data.json') })
  stores.push(store)
  return store
}

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: WT,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('Store host partition before-unload stage', () => {
  it('keeps the host tabs when the renderer slice omits tabsByWorktree', () => {
    const store = createStore()
    store.setWorkspaceSession(
      {
        activeRepoId: 'repo-1',
        activeWorktreeId: WT,
        activeTabId: 'tab-1',
        tabsByWorktree: { [WT]: [tab()] },
        terminalLayoutsByTabId: {},
        terminalTopologyRevisionByRepoId: { 'repo-1': 1 }
      },
      HOST_ID
    )

    // The renderer's per-host split drops tabsByWorktree for a host slice that has no tabs.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reproduces the runtime payload that omits a required field.
    const slice = {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: 'tab-1',
      terminalLayoutsByTabId: {}
    } as WorkspaceSessionState

    expect(() => store.stageWorkspaceSessionBeforeUnload(slice, HOST_ID)).not.toThrow()
    expect(store.getWorkspaceSession(HOST_ID).tabsByWorktree[WT]).toHaveLength(1)
  })
})
