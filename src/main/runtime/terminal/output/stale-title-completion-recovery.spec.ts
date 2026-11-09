import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import '../../../../shared/agent-status/title/osc-title-extraction'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import '../../../ipc/pty/pane/key-state'
import '../../../startup/main-process-state'
import '../../../startup/synthetic-title-runtime'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from '../../orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'

describe('hook title evidence and completion recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Synthetic: Codex's done hook, then a final native spinner that only the timer clears (#19243).
  it('delivers mail to a live Codex behind a fresh done hook and a stale spinner', async () => {
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
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('delivers mail to a program that reports its status but never sets a title', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-titleless-program-status-')
    const { runtime, write } = createRuntime(db, { launchAgent: 'antigravity' })
    const run = createBoundRun(db, 'Titleless Run')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=working:app=antigravity\x07', 1)
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=done:app=antigravity\x07> ', 2)
    insertDirectRunMessage(db, run.id, 'Worker done')
    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
})
