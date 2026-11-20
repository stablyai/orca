import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import type * as PtyPaneRecord from '../terminal/query/pty-pane-record'
import { OrchestrationMailboxPointerDelivery } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-delivery'
import {
  createDatabase,
  createRuntime,
  temporaryDirectories
} from '../orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'

const lookups = vi.hoisted(() => ({ count: 0 }))
vi.mock('../terminal/query/pty-pane-record', async (load) => {
  const actual = await load<typeof PtyPaneRecord>()
  return {
    ...actual,
    ptyRecordForPaneKey: (...args: Parameters<typeof actual.ptyRecordForPaneKey>) => {
      lookups.count++
      return actual.ptyRecordForPaneKey(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([300, 3000])(
  'structured-chat status (%i rows) never makes mail look up a terminal',
  async (rows) => {
    const db = createDatabase('orca-structured-status-mail-')
    const { runtime } = await createRuntime(db)
    const server = new AgentHookServer()
    const listeners: ((row: EnrichedAgentHookEventPayload) => void)[] = []
    runtime.attachAgentStatusStore({
      getStatusSnapshot: () => server.getStatusSnapshot(),
      getStatusSnapshotForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
      subscribeStatusRowMutations: () => () => {},
      subscribeStatusFreshness: () => () => {},
      subscribeEnrichedStatus: (listener) => {
        listeners.push(listener)
        return () => {}
      }
    })
    const observe = vi.spyOn(OrchestrationMailboxPointerDelivery.prototype, 'observeTerminal')
    lookups.count = 0
    try {
      for (let i = 0; i < rows; i++) {
        const row: EnrichedAgentHookEventPayload = {
          paneKey: `structured-tab-${i}:session-${i}`,
          tabId: `structured-tab-${i}`,
          worktreeId: 'repo::/tmp/structured',
          connectionId: null,
          structuredHost: 'owned',
          receivedAt: i,
          stateStartedAt: i,
          payload: { state: 'working', prompt: '', agentType: 'claude' }
        }
        for (const listener of listeners) {
          listener(row)
        }
      }
      expect(lookups.count).toBe(0)
      expect(observe).toHaveBeenCalledTimes(0)
    } finally {
      db.close()
    }
  }
)
