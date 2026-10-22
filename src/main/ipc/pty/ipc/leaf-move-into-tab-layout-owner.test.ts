import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { agentHookServer } from '../../../agent-hooks/server'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { TerminalLeafIntoTabRequest } from '../../../../shared/terminal-leaf-move'
import { makeRepo } from '../../../persistence-test-harness'
import {
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from '../../../persistence/profile-state/profile-state-database'
import {
  closeMoveTestStores,
  LEFT,
  MOVED,
  newDataFile,
  openStore,
  ownersOf,
  SOURCE,
  TARGET,
  FROM,
  WT
} from '../../../persistence/terminal-topology/terminal-leaf-move-fixture'
import { noopPtyIpcSurface, setPtyHostBindings } from '../../pty-host-bindings'
import {
  getPtyIdForPaneKey,
  paneKeyPtyId,
  ptyPaneKey,
  rememberPaneKeyForPty
} from '../pane/key-state'
import { installPtyLeafMoveIpcHandler } from './leaf-move'

// A layout-owner build draws every move from main's frames, so a window-applied join must change nothing.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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

afterEach(async () => {
  await closeMoveTestStores()
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  setPtyHostBindings({})
})

const request: TerminalLeafIntoTabRequest = {
  worktreeId: WT,
  sourceTabId: SOURCE,
  targetTabId: TARGET,
  targetLeafId: LEFT,
  leafId: MOVED,
  ptyId: 'pty-agent',
  placement: { kind: 'beside', side: 'right' }
}

function readDocument(dataFile: string, domain: string): string {
  const opened = openProfileStateDatabaseReadOnly(
    profileStateDatabaseFile(dirname(dataFile)),
    'persistence-test'
  )
  try {
    const row: unknown = opened.db
      .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
      .get(domain)
    return row && typeof row === 'object' && 'payload' in row ? String(row.payload) : ''
  } finally {
    opened.db.close()
  }
}

describe('pty:moveLeafIntoTab in a layout-owner build, past every renderer guard', () => {
  it('refuses before the Store: session, alias, re-key and source tab are all unchanged', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: SOURCE,
      leafId: MOVED,
      ptyId: 'pty-agent',
      incarnationId: 'inc-1'
    })
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: TARGET,
      leafId: LEFT,
      ptyId: 'pty-left',
      incarnationId: 'inc-left'
    })
    rememberPaneKeyForPty('pty-agent', FROM)
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority')
    const moveIntoTab = vi.spyOn(store, 'moveTerminalLeafIntoTab')
    const rekeyOrchestration = vi.fn(() => 1)
    const restamp = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    const runtime = {
      getExistingOrchestrationDb: () => ({
        rekeyWorkerTerminalResourcePaneKey: rekeyOrchestration
      }),
      restampMovedPtySurface: restamp
    } as unknown as OrcaRuntimeService
    const sessionBefore = structuredClone(store.getWorkspaceSession())
    const aliasesBefore = readDocument(dataFile, 'legacyPaneKeyAliasEntries')

    const handlers = new Map<string, (event: IpcMainInvokeEvent, args: unknown) => unknown>()
    setPtyHostBindings({
      ipc: { ...noopPtyIpcSurface, handle: (channel, listener) => handlers.set(channel, listener) }
    })
    installPtyLeafMoveIpcHandler({ store, runtime })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler never reads the event.
    const answer = await handlers.get('pty:moveLeafIntoTab')?.({} as IpcMainInvokeEvent, request)

    expect(answer).toEqual({ status: 'refused', reason: 'layout_owner_build' })
    expect(moveIntoTab).not.toHaveBeenCalled()
    expect(store.getWorkspaceSession()).toEqual(sessionBefore)
    expect(ownersOf(store.getWorkspaceSession(), 'pty-agent')).toEqual([FROM])
    expect(store.getWorkspaceSession().tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(SOURCE)
    expect(readDocument(dataFile, 'legacyPaneKeyAliasEntries')).toBe(aliasesBefore)
    expect(transfer).not.toHaveBeenCalled()
    expect(restamp).not.toHaveBeenCalled()
    expect(rekeyOrchestration).not.toHaveBeenCalled()
    expect(getPtyIdForPaneKey(FROM)).toBe('pty-agent')
  })
})
