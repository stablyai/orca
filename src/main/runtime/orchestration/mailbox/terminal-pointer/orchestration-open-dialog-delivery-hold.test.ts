import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
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
import { USER_INPUT_HOLD_CAP_MS } from '../../../terminal/wait/claude-open-dialog-hold'
import { settledWriteStub } from '../../../../providers/settled-pty-write-stub'

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

describe('mailbox delivery into a pane awaiting the user', () => {
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

  it.each([
    ['sent', 'driving', '\x1b[2J\x1b[H', 5000],
    ['abandoned past the cap', 'driving', '', USER_INPUT_HOLD_CAP_MS],
    ["not for Orca's own launch draft", 'launch', '', 0]
  ] as const)(
    'holds the pointer while the composer has an unsent draft; %s',
    async (_label, inputKind, screenAfter, waitAfterMs) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-composer-draft-delivery-hold-')
      const { runtime, write } = createRuntime(db, {
        getAgentStatusSnapshot: () => [claudeHookRow('done')],
        checkHookAgentPresence: async () => 'live',
        launchAgent: 'claude'
      })
      const run = createBoundRun(db, 'Claude Run')
      await runtime.listTerminals()
      runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })

      runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${'─'.repeat(40)}\r\n❯ `, 1)
      runtime.terminalRunFacts.recordInput(PTY_ID, inputKind, 'please refactor the auth')
      runtime.onPtyData(PTY_ID, 'please refactor the auth', 2)
      await vi.advanceTimersByTimeAsync(200)
      insertDirectRunMessage(db, run.id, 'Worker heartbeat')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(write).toHaveBeenCalledTimes(inputKind === 'launch' ? 2 : 0)

      runtime.onPtyData(PTY_ID, screenAfter, 3)
      await vi.advanceTimersByTimeAsync(waitAfterMs)

      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      db.close()
    }
  )

  it("delivers past the agent's dim prompt suggestion right after the user typed (#38015)", async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-prompt-suggestion-delivery-')
    const { runtime, write } = createRuntime(db, {
      getAgentStatusSnapshot: () => [claudeHookRow('done')],
      checkHookAgentPresence: async () => 'live',
      launchAgent: 'claude'
    })
    const run = createBoundRun(db, 'Claude Run')
    await runtime.listTerminals()

    runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'add a second line\r')
    runtime.onPtyData(
      PTY_ID,
      `\x1b]0;✳ Claude Code\x07${'─'.repeat(40)}\r\n❯ \x1b7\x1b[2madd a timestamp line\x1b[22m\x1b8\r\n${'─'.repeat(40)}\x1b[1A\x1b[3G`,
      1
    )
    await vi.advanceTimersByTimeAsync(200)
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it.each([
    ['a draft typed before the restart', 'please refactor the auth'],
    // Orca died between typing a pointer and its Enter: the new pointer follows it and both submit.
    [
      "Orca's own unsent pointer",
      'You have 1 orchestration message. Run `orca orchestration check`.'
    ]
  ] as const)(
    'after an Orca restart reattaches the agent, holds mail behind %s until the cap',
    async (_label, composerText) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-restored-draft-delivery-hold-')
      const { runtime, write } = createRuntime(db, {
        getAgentStatusSnapshot: () => [claudeHookRow('done')],
        checkHookAgentPresence: async () => 'live',
        launchAgent: 'claude'
      })
      const run = createBoundRun(db, 'Claude Run')
      await runtime.listTerminals()

      runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${'─'.repeat(40)}\r\n❯ ${composerText}`, 1)
      await vi.advanceTimersByTimeAsync(200)
      insertDirectRunMessage(db, run.id, 'Worker heartbeat')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(write).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(USER_INPUT_HOLD_CAP_MS)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      db.close()
    }
  )

  it('after an Orca restart, holds mail while the restored screen is still loading', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-restoring-screen-delivery-hold-')
    const { runtime } = createRuntime(db, {
      getAgentStatusSnapshot: () => [claudeHookRow('done')],
      checkHookAgentPresence: async () => 'live',
      launchAgent: 'claude'
    })
    let finishRestore = (_screen: string): void => {}
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer: () =>
        new Promise((resolve) => {
          finishRestore = (data) => resolve({ data, cols: 80, rows: 24 })
        })
    })
    const run = createBoundRun(db, 'Claude Run')
    await runtime.listTerminals()

    runtime.onPtyData(PTY_ID, '\x1b]0;✳ Claude Code\x07', 1)
    await vi.advanceTimersByTimeAsync(200)
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(write).not.toHaveBeenCalled()

    finishRestore(`${'─'.repeat(40)}\r\n❯ `)
    await vi.advanceTimersByTimeAsync(5000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
  it('delivers working-turn mail only after an adopted wrapper has current composer evidence', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-adopted-working-mail-')
    const { runtime, write } = createRuntime(db, { launchAgent: null })
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'node',
      confirmForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'adopted Claude')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const working = '\x1b]9999;{"state":"working","agentType":"claude"}\x07'
    runtime.onPtyData(PTY_ID, `\x1b]133;C\x07\x1b]0;claude\x07hook text\r\n${working}`, Date.now())
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(write).not.toHaveBeenCalled()
    runtime.onPtyData(PTY_ID, `\x1b[?2031h\x1b[?2004h❯\u00a0${working}`, Date.now())
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('preserves adopted OMP identity, readiness and mail across a split recorded app zone', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-adopted-omp-app-zone-')
    const { runtime, write } = createRuntime(db, { launchAgent: null })
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getSize: () => ({ cols: 100, rows: 30 }),
      getForegroundProcess: async () => 'omp'
    })
    const run = createBoundRun(db, 'adopted OMP')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(PTY_ID, '\x1b]133;C\x07\x1b]0;π > capture-cwd\x07', Date.now())
    await runtime.isTerminalRunningSettledPromptAgent(TERMINAL_HANDLE)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('omp')
    const recorded = readFileSync(
      join(__dirname, '../../../__fixtures__/omp-user-bubble-osc133-zone.txt'),
      'utf8'
    )
    const prefix = '\x1b]133;B\x07\x1b]133;C\x07'
    const cut = recorded.indexOf(prefix) + prefix.length
    runtime.onPtyData(PTY_ID, recorded.slice(0, cut), Date.now())
    const idle = runtime.waitForTerminal(TERMINAL_HANDLE, {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    const settled = vi.fn()
    idle.then(settled, () => {})
    insertDirectRunMessage(db, run.id, 'OMP heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('omp')
    expect(settled).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    runtime.onPtyData(PTY_ID, recorded.slice(cut), Date.now())
    runtime.onPtyData(PTY_ID, '\x1b]0;π > capture-cwd\x07', Date.now())
    const keepalive = setInterval(() => runtime.onPtyData(PTY_ID, '\x1b[?2004h', Date.now()), 1000)
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(keepalive)
    expect(settled).toHaveBeenCalled()
    await expect(idle).resolves.toMatchObject({ satisfied: true })
    expect((await runtime.listTerminals()).terminals[0]?.agentIdentity).toBe('omp')
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('delivers working mail to a current adopted non-TUI terminal agent', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-working-dsb-mail-')
    const { runtime, write } = createRuntime(db, { launchAgent: null })
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'dsb'
    })
    const run = createBoundRun(db, 'adopted dsb')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(PTY_ID, '\x1b]133;C\x07\x1b]0;⠋ - Build - DeepSeek Build\x07', Date.now())
    await runtime.isTerminalRunningSettledPromptAgent(TERMINAL_HANDLE)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('dsb')
    insertDirectRunMessage(db, run.id, 'Build heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
})
