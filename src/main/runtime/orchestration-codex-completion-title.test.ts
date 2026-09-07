import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { MAILBOX_POINTER_WRITE_ATTEMPTED } from './orchestration/db/messages/mailbox-pointer-enter-state'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  LEAF_ID,
  PANE_KEY,
  PTY_ID,
  TAB_ID,
  TERMINAL_HANDLE,
  temporaryDirectories,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function completionFixture(delayMs = 0) {
  const db = createDatabase('orca-codex-completion-title-')
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
  const getForegroundProcess = vi.fn(async (): Promise<string | null> => {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return 'codex'
  })
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess
  })
  const run = createBoundRun(db, 'Completion title Run')
  function completeWithNativeTitles(): void {
    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ mobile-rearch\x07', 1)
    runtime.onPtyData(PTY_ID, '\x1b]0;mobile-rearch\x07', 2)
  }
  return { db, runtime, write, run, hook, getForegroundProcess, completeWithNativeTitles }
}

describe('Codex completion title mailbox delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { arrival: 'before', delay: 0 },
    { arrival: 'after', delay: 0 },
    { arrival: 'before', delay: 750 },
    { arrival: 'after', delay: 750 }
  ])(
    'submits mail arriving $arrival completion with a $delay ms host probe',
    async ({ arrival, delay }) => {
      vi.useFakeTimers()
      const { db, runtime, write, run, completeWithNativeTitles } = completionFixture(delay)
      await runtime.listTerminals()
      if (arrival === 'before') {
        insertDirectRunMessage(db, run.id, 'Worker progress')
      }
      completeWithNativeTitles()
      await vi.advanceTimersByTimeAsync(100)
      if (arrival === 'after') {
        insertDirectRunMessage(db, run.id, 'Worker progress')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      }
      await vi.advanceTimersByTimeAsync(500)
      if (delay) {
        expect(write).not.toHaveBeenCalledWith(PTY_ID, '\r')
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      db.close()
    }
  )

  it.each([
    { name: 'shell', process: 'zsh' },
    { name: 'unverifiable foreground', process: null },
    { name: 'different agent', process: 'claude' },
    { name: 'working hook', state: 'working' as const },
    { name: 'permission hook', state: 'blocked' as const },
    { name: 'restored hook', restoredUnconfirmed: true },
    { name: 'stale hook', age: AGENT_STATUS_STALE_AFTER_MS + 1 }
  ])('does not recover idle from $name', async (scenario) => {
    vi.useFakeTimers()
    const { db, runtime, write, run, hook, getForegroundProcess, completeWithNativeTitles } =
      completionFixture()
    if (scenario.process !== undefined) {
      getForegroundProcess.mockResolvedValue(scenario.process)
    }
    if (scenario.state !== undefined) {
      hook.state = scenario.state
    }
    if ('restoredUnconfirmed' in scenario) {
      hook.restoredUnconfirmed = true
    }
    if (scenario.age !== undefined) {
      hook.receivedAt -= scenario.age
    }
    await runtime.listTerminals()
    completeWithNativeTitles()
    await vi.advanceTimersByTimeAsync(100)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })

  it('does not restore idle over a permission title received during the host probe', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, completeWithNativeTitles } = completionFixture(750)
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Worker progress')
    completeWithNativeTitles()
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex waiting for permission\x07', 3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message')
    ])
    db.close()
  })

  it('keeps an unverified staged pointer pending and submits it once readiness returns', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, getForegroundProcess, completeWithNativeTitles } =
      completionFixture()
    getForegroundProcess.mockResolvedValue(null)
    await runtime.listTerminals()
    const message = insertDirectRunMessage(db, run.id, 'Worker progress')
    completeWithNativeTitles()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message')
    ])
    expect(db.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED
    })

    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(message.id)).toMatchObject({ pointer_enter_pending: 0 })
    db.close()
  })

  it('rechecks a repeated neutral title before resuming the staged Enter', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, completeWithNativeTitles } = completionFixture(750)
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Worker progress')
    completeWithNativeTitles()
    await vi.advanceTimersByTimeAsync(100)
    runtime.onPtyData(PTY_ID, '\x1b]0;mobile-rearch\x07', 3)
    await vi.advanceTimersByTimeAsync(700)
    expect(write).not.toHaveBeenCalledWith(PTY_ID, '\r')
    await vi.advanceTimersByTimeAsync(1500)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('does not restore a completed hook after a new turn starts during the probe', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, hook, completeWithNativeTitles } = completionFixture(750)
    await runtime.listTerminals()
    completeWithNativeTitles()
    hook.state = 'working'
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1500)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })

  it('does not restore completion into a replacement process using the same PTY id', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, completeWithNativeTitles } = completionFixture(750)
    await runtime.listTerminals()
    completeWithNativeTitles()
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'replacement-incarnation'
    })
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1500)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })

  it('does not reuse a completion hook from before a provider generation reset', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run } = completionFixture()
    await runtime.listTerminals()
    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    await vi.advanceTimersByTimeAsync(10)
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ mobile-rearch\x07', 1)
    runtime.onPtyData(PTY_ID, '\x1b]0;mobile-rearch\x07', 2)
    await vi.advanceTimersByTimeAsync(100)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })

  it('discards a foreground probe spanning a generation reset even with a newer done hook', async () => {
    vi.useFakeTimers()
    const { db, runtime, write, run, hook, completeWithNativeTitles } = completionFixture(750)
    await runtime.listTerminals()
    completeWithNativeTitles()
    await vi.advanceTimersByTimeAsync(100)
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    await vi.advanceTimersByTimeAsync(1)
    hook.receivedAt = Date.now()
    hook.stateStartedAt = Date.now()
    await vi.advanceTimersByTimeAsync(1000)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })
})
