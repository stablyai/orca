import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import { fixture } from '../loading-store/profile-state-delayed-authority-fixture'
import {
  FROM,
  LEFT,
  MOVED,
  SOURCE,
  TARGET,
  TO,
  WT,
  moveRequest
} from './terminal-leaf-move-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
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
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  agentHookServer.stop()
})

afterEach(() => {
  agentHookServer.stop()
})

function relayEventFromOldKey(prompt: string): void {
  agentHookServer.ingestRemote(
    { paneKey: FROM, tabId: SOURCE, worktreeId: WT, payload: { state: 'working', prompt } },
    'conn-1'
  )
}

const rows = () => agentHookServer.getStatusSnapshot().map((row) => [row.paneKey, row.prompt])

it('keeps a rolled-back move from leaving a fallback alias or a row at the destination', async () => {
  const { store, authority } = await fixture()
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: LEFT,
    ptyId: 'pty-left',
    incarnationId: 'inc-left'
  })
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: MOVED,
    ptyId: 'pty-agent',
    incarnationId: 'inc-1'
  })
  await store.flushPendingOrThrowAsync()
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const gate = authority.pause()
  authority.failNextWrite()
  const move = store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
  const refused = expect(move).rejects.toThrow('profile_state_write_failed')
  await gate.started.promise
  // The move is applied in memory and its save is pending: a hook now reads the uncommitted layout.
  relayEventFromOldKey('while the save is pending')
  gate.finish.resolve()
  await refused

  expect(store.getWorkspaceSession().terminalLayoutsByTabId[TARGET]).toBeUndefined()
  expect(agentHookServer.resolvePaneAuthorityOwner(FROM)).toBe(FROM)
  expect(rows().map(([paneKey]) => paneKey)).not.toContain(TO)
  relayEventFromOldKey('after the rollback')
  expect(rows()).toEqual([[FROM, 'after the rollback']])
})

it('routes a lost-alias notification to the moved pane while an unrelated write is in flight and after it settles', async () => {
  const { store, authority } = await fixture()
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: LEFT,
    ptyId: 'pty-left',
    incarnationId: 'inc-left'
  })
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: MOVED,
    ptyId: 'pty-agent',
    incarnationId: 'inc-1'
  })
  await store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
  // The move committed, but the hook server never learned its alias (evicted, or lost in a crash).
  expect(agentHookServer.resolvePaneAuthorityOwner(FROM)).toBe(FROM)

  const gate = authority.pause()
  const unrelated = store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: LEFT,
    ptyId: 'pty-left-2',
    incarnationId: 'inc-left-2'
  })
  await gate.started.promise
  relayEventFromOldKey('while an unrelated save is pending')
  gate.finish.resolve()
  await unrelated
  relayEventFromOldKey('after the unrelated save')

  expect(rows()).toEqual([[TO, 'after the unrelated save']])
})
