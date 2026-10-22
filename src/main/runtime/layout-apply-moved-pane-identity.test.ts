import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { agentHookServer } from '../agent-hooks/server'
import { getPtyIdForPaneKey, paneKeyPtyId, ptyPaneKey } from '../ipc/pty/pane/key-state'
import {
  closeMoveTestStores,
  FROM,
  LEFT,
  MOVED,
  newDataFile,
  openStore,
  seedSplitSource,
  SOURCE,
  TARGET,
  WT
} from '../persistence/terminal-topology/terminal-leaf-move-fixture'
import {
  closeSourceTab,
  crashAndRestartThroughStore,
  persistedAliases,
  postStatusFromOldKey,
  seedStatusAtSourceKey,
  statusRows
} from '../persistence/terminal-topology/moved-pane-identity-scenario'
import { OrcaRuntimeService } from './orca-runtime'

// Past the Store's save debounce and its max wait.
const PAST_SAVE_DEBOUNCE_MS = 6_000

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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

/** The window's drag-out, as `layout.apply` carries it, over the runtime's real entry. */
function detachCommand() {
  return {
    type: 'movePaneToNewTab' as const,
    workspace: WT,
    tabId: SOURCE,
    leafId: MOVED,
    windowDetach: { ptyId: 'pty-agent', tabId: TARGET }
  }
}

/** Layout-owner main names the new tab itself; the reply carries it. */
async function movedPaneKey(
  runtime: OrcaRuntimeService
): Promise<{ tabId: string; paneKey: string }> {
  const reply = await runtime.applyLayoutCommand(detachCommand())
  if (!reply.ok || !reply.result || !('tabId' in reply.result) || !reply.result.tabId) {
    throw new Error(`move was not applied: ${JSON.stringify(reply)}`)
  }
  return { tabId: reply.result.tabId, paneKey: `${reply.result.tabId}:${MOVED}` }
}

beforeEach(() => {
  agentHookServer.stop()
})

afterEach(async () => {
  agentHookServer.stop()
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  await closeMoveTestStores()
})

describe('layout.apply movePaneToNewTab with windowDetach keeps a moved pane identity end to end', () => {
  it('routes a status posted from the old key to the new owner after the old tab closes', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    seedStatusAtSourceKey()
    ptyPaneKey.set('pty-agent', FROM)
    paneKeyPtyId.set(FROM, 'pty-agent')
    const runtime = new OrcaRuntimeService(store)
    const restamp = vi.spyOn(runtime, 'restampMovedPtySurface').mockImplementation(() => {})

    const to = await movedPaneKey(runtime)
    closeSourceTab()
    postStatusFromOldKey('after the old tab closed')

    expect(statusRows()).toEqual([[to.paneKey, 'after the old tab closed']])
    expect(getPtyIdForPaneKey(to.paneKey)).toBe('pty-agent')
    expect(restamp).toHaveBeenCalledWith('pty-agent', to.tabId, to.paneKey)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEFT }
    })
  })

  // The alias listener stays attached, so the move's own durable write races the debounced save.
  describe.each([
    { name: 'before the debounced save', saveSettled: false },
    { name: 'after the debounced save', saveSettled: true }
  ])('a crash $name', ({ saveSettled }) => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps the old-key alias after a Store restart', async () => {
      const dataFile = newDataFile()
      const store = openStore(dataFile)
      await seedSplitSource(store)
      await store.flushPendingOrThrowAsync()
      seedStatusAtSourceKey()
      const runtime = new OrcaRuntimeService(store)
      vi.spyOn(runtime, 'restampMovedPtySurface').mockImplementation(() => {})

      const to = await movedPaneKey(runtime)
      if (saveSettled) {
        await vi.advanceTimersByTimeAsync(PAST_SAVE_DEBOUNCE_MS)
        await store['runtime'].pendingWrite
      }
      expect(store['runtime'].writeTimer === null).toBe(saveSettled)

      await crashAndRestartThroughStore(store, dataFile)
      expect(persistedAliases(dataFile)).toEqual([
        expect.objectContaining({
          legacyPaneKey: FROM,
          stablePaneKey: to.paneKey,
          ptyId: 'pty-agent'
        })
      ])
      closeSourceTab()
      postStatusFromOldKey('after the restart')
      expect(statusRows()).toEqual([[to.paneKey, 'after the restart']])
    })
  })
})
