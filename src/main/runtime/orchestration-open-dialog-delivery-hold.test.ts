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

function claudeHookRow(state: AgentStatusIpcPayload['state']): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    terminalHandle: TERMINAL_HANDLE,
    agentType: 'claude',
    state,
    prompt: '',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now()
  }
}

const QUESTION_SCREEN =
  '\x1b]0;✳ Claude Code\x07Which color?\r\n❯ 1. Red\r\n  2. Blue\r\n' +
  'Enter to select · ↑/↓ to navigate · Esc to cancel\r\n'

describe('mailbox delivery into a pane with an open dialog', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['answered', 'done', '\x1b[2J\x1b[H❯ \r\n', 2],
    ['dismissed with Esc, which posts no hook', 'waiting', '\x1b[2J\x1b[H❯ \r\n', 2],
    ['only navigated', 'waiting', '\x1b[2J\x1b[H  1. Red\r\n❯ 2. Blue\r\n', 0]
  ] as const)(
    'holds the pointer under a rest title while a question shows; %s',
    async (_label, rowAfter, screenAfter, expectedWrites) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-open-dialog-delivery-hold-')
      let hook = claudeHookRow('waiting')
      const { runtime, write } = createRuntime(db, {
        getAgentStatusSnapshot: () => [hook],
        checkHookAgentPresence: async () => 'live',
        launchAgent: 'claude'
      })
      const run = createBoundRun(db, 'Claude Run')
      await runtime.listTerminals()

      runtime.onPtyData(PTY_ID, QUESTION_SCREEN, 1)
      await vi.advanceTimersByTimeAsync(200)
      insertDirectRunMessage(db, run.id, 'Worker heartbeat')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(write).not.toHaveBeenCalled()

      if (rowAfter === 'done') {
        hook = claudeHookRow('done')
      }
      runtime.onPtyData(PTY_ID, screenAfter, 2)
      await vi.advanceTimersByTimeAsync(5000)

      expect(write.mock.calls.map(([, data]) => data)).toEqual(
        expectedWrites === 0
          ? []
          : [expect.stringContaining('You have 1 orchestration message'), '\r']
      )
      db.close()
    }
  )
})
