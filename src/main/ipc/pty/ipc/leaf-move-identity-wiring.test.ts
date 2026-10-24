import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { agentHookServer } from '../../../agent-hooks/server'
import { getPtyIdForPaneKey, paneKeyPtyId, ptyPaneKey } from '../pane/key-state'
import {
  closeMoveTestStores,
  FROM,
  moveRequest,
  newDataFile,
  openStore,
  seedSplitSource,
  TARGET,
  TO
} from '../../../persistence/terminal-topology/terminal-leaf-move-fixture'
import {
  closeSourceTab,
  crashAndRestartThroughStore,
  persistedAliases,
  postStatusFromOldKey,
  seedStatusAtSourceKey,
  startHookServerOnProfile,
  writeStatusFileAtSourceKey,
  restartThroughStore,
  statusRows
} from '../../../persistence/terminal-topology/moved-pane-identity-scenario'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { commitLeafMoveAndRekey } from './leaf-move'

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

// Past the Store's save debounce and its max wait.
const PAST_SAVE_DEBOUNCE_MS = 6_000

function runtimeStub() {
  const restampMovedPtySurface = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rekey reads only these two runtime members.
  const runtime = {
    getExistingOrchestrationDb: () => null,
    restampMovedPtySurface
  } as unknown as OrcaRuntimeService
  return { runtime, restampMovedPtySurface }
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

// The wiring through the real Store: IPC pty:moveLeafToNewTab -> commitLeafMoveAndRekey.
describe('pty:moveLeafToNewTab keeps a moved pane identity end to end', () => {
  it('routes a status posted from the old key to the new owner after the old tab closes', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    seedStatusAtSourceKey()
    const { runtime, restampMovedPtySurface } = runtimeStub()
    ptyPaneKey.set('pty-agent', FROM)
    paneKeyPtyId.set(FROM, 'pty-agent')

    await expect(
      commitLeafMoveAndRekey({ store, runtime }, { ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-agent' })
    closeSourceTab()
    postStatusFromOldKey('after the old tab closed')

    expect(statusRows()).toEqual([[TO, 'after the old tab closed']])
    expect(getPtyIdForPaneKey(TO)).toBe('pty-agent')
    expect(restampMovedPtySurface).toHaveBeenCalledWith('pty-agent', 'tab-target', TO)
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

    it('keeps the old-key alias and the saved status after a Store restart', async () => {
      const dataFile = newDataFile()
      const store = openStore(dataFile)
      await seedSplitSource(store)
      await store.flushPendingOrThrowAsync()
      seedStatusAtSourceKey()
      await commitLeafMoveAndRekey(
        { store, runtime: runtimeStub().runtime },
        { ...moveRequest, ptyId: 'pty-agent' }
      )
      if (saveSettled) {
        await vi.advanceTimersByTimeAsync(PAST_SAVE_DEBOUNCE_MS)
        await store['runtime'].pendingWrite
      }
      expect(store['runtime'].writeTimer === null).toBe(saveSettled)

      writeStatusFileAtSourceKey(dataFile, 'saved before the move')
      await crashAndRestartThroughStore(store, dataFile)
      expect(persistedAliases(dataFile)).toEqual([
        expect.objectContaining({ legacyPaneKey: FROM, stablePaneKey: TO, ptyId: 'pty-agent' })
      ])
      await startHookServerOnProfile(dataFile)
      expect(statusRows()).toEqual([[TO, 'saved before the move']])

      closeSourceTab()
      postStatusFromOldKey('after the restart')
      expect(statusRows()).toEqual([[TO, 'after the restart']])
    })
  })

  it('restores a saved status row under the new key at startup, before any new notification', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    await seedSplitSource(store)
    await commitLeafMoveAndRekey(
      { store, runtime: runtimeStub().runtime },
      { ...moveRequest, ptyId: 'pty-agent' }
    )
    writeStatusFileAtSourceKey(dataFile, 'saved before the move')

    await restartThroughStore(store, dataFile)
    await startHookServerOnProfile(dataFile)

    expect(statusRows()).toEqual([[TO, 'saved before the move']])
    expect(agentHookServer.getStatusSnapshot()[0]?.tabId).toBe(TARGET)
  })
})
