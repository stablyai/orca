import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

import '../../persistence-test-harness'
import {
  closeMoveTestStores,
  MOVED,
  moveRequest,
  newDataFile,
  openStore,
  seedSplitSource,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  WT
} from '../testing/terminal-leaf-move-fixture'
import '../terminal-topology-commit'

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

afterEach(closeMoveTestStores)

const request = { ...moveRequest, ptyId: 'pty-agent' }

// The renderer completes a post-move close against main's new tab.

// In-flight drags must refuse: a spawn without captured PTY identity can recreate SOURCE:leaf after move.
it('grafts a late spawn result for the moved leaf back into its source tab', async () => {
  const store = openStore(newDataFile())
  await seedSplitSource(store)
  await store.moveTerminalLeafToNewTab({ ...request, ptyId: null })
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: MOVED,
    ptyId: 'pty-late',
    incarnationId: 'inc-late'
  })
  expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED).sort()).toEqual([SOURCE, TARGET])
})
