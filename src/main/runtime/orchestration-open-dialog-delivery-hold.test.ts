import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
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
import { USER_INPUT_HOLD_CAP_MS } from './claude-open-dialog-hold'

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
    ['holds a draft typed before the restart until the cap', 'please refactor the auth', true],
    ["does not hold on Orca's own unsent pointer", 'You have 1 orchestration message.', false]
  ] as const)(
    'after an Orca restart reattaches the agent, %s',
    async (_label, composerText, held) => {
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
      expect(write).toHaveBeenCalledTimes(held ? 0 : 2)

      await vi.advanceTimersByTimeAsync(USER_INPUT_HOLD_CAP_MS)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      db.close()
    }
  )
})
