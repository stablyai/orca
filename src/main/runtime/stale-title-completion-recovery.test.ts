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

describe('stale-working title clear and completion recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Synthetic: Codex's done hook, then a final native spinner that only the timer clears (#19243).
  it('delivers mail once the clear confirms a live Codex behind a fresh done hook', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-stale-title-completion-')
    const hook: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      agentType: 'codex',
      state: 'done',
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    const { runtime } = createRuntime(db, { getAgentStatusSnapshot: () => [hook] })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: vi.fn(async () => 'codex')
    })
    const run = createBoundRun(db, 'Timer Run')
    await runtime.listTerminals()
    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ mobile-rearch\x07', 1)
    runtime.onPtyData(PTY_ID, 'composer repaint without a title', 2)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
})
