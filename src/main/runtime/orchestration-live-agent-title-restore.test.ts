import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
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

describe('neutral title while the hook-owned agent process is alive', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores the idle agent and delivers mail without a foreground read', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-live-agent-title-restore-')
    const hook: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      agentType: 'claude',
      state: 'done',
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    const { runtime } = createRuntime(db, {
      getAgentStatusSnapshot: () => [hook],
      checkHookAgentPresence: async () => 'live'
    })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    const getForegroundProcess = vi.fn(async () => 'claude')
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess
    })
    const run = createBoundRun(db, 'Claude Run')
    await runtime.listTerminals()

    runtime.onPtyData(PTY_ID, '\x1b]0;✳ Claude Code\x07', 1)
    await vi.advanceTimersByTimeAsync(50)
    runtime.onPtyData(PTY_ID, '\x1b]0;some-tool-title\x07', 2)
    await vi.advanceTimersByTimeAsync(200)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(3000)

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
})
