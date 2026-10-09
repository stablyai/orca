import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function claudeHookRow(state: AgentStatusIpcPayload['state'], ageMs = 0): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    terminalHandle: TERMINAL_HANDLE,
    agentType: 'claude',
    state,
    prompt: '',
    connectionId: null,
    receivedAt: Date.now() - ageMs,
    stateStartedAt: Date.now() - ageMs
  }
}

describe('mailbox delivery into a pane with an open dialog', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['just opened', 0],
    ['open past the 30-minute hook freshness window', 31 * 60_000]
  ])(
    'holds the pointer under a rest title while a question is %s, then delivers',
    async (_label, ageMs) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-open-dialog-delivery-hold-')
      let hook = claudeHookRow('waiting', ageMs)
      const { runtime, write } = createRuntime(db, {
        getAgentStatusSnapshot: () => [hook],
        checkHookAgentPresence: async () => 'live',
        launchAgent: 'claude'
      })
      const run = createBoundRun(db, 'Claude Run')
      await runtime.listTerminals()

      runtime.onPtyData(PTY_ID, '\x1b]0;✳ Claude Code\x07', 1)
      await vi.advanceTimersByTimeAsync(200)
      insertDirectRunMessage(db, run.id, 'Worker heartbeat')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10_000)

      expect(write).not.toHaveBeenCalled()

      hook = claudeHookRow('done')
      await vi.advanceTimersByTimeAsync(4000)

      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      db.close()
    }
  )
})
