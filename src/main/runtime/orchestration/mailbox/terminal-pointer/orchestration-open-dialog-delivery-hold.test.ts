import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { sendDeliveryHoldWarning } from '../../../rpc/methods/orchestration/messaging/send-delivery-hold'
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

  it('keeps mail unread at a title-setting shell and delivers after the agent returns', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-shell-mail-hold-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    let foreground: 'codex' | 'zsh' = 'codex'
    let nextForegroundRead: Promise<void> | undefined
    const delayNextForegroundRead = (): (() => void) => {
      let release = (): void => {}
      nextForegroundRead = new Promise((resolve) => {
        release = resolve
      })
      return release
    }
    const sampleForeground = async (): Promise<typeof foreground> => {
      const sampled = foreground
      const delayed = nextForegroundRead
      nextForegroundRead = undefined
      await delayed
      return sampled
    }
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex',
      confirmForegroundProcess: async () => foreground,
      confirmShellForeground: async () => (await sampleForeground()) === 'zsh',
      supportsForegroundObservation: () => true,
      inspectProcess: async () => {
        const sampled = await sampleForeground()
        return {
          foregroundProcess: sampled,
          hasChildProcesses: sampled !== 'zsh',
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'mailbox-test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: sampled === 'zsh' ? 'shell' : 'non-shell',
            processName: sampled
          }
        }
      }
    })
    const run = createBoundRun(db, 'Foreground delivery')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
    await vi.advanceTimersByTimeAsync(200)

    foreground = 'zsh'
    runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', 2)
    await vi.advanceTimersByTimeAsync(200)
    const message = insertDirectRunMessage(db, run.id, 'Worker finished')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
    const receipt = await sendDeliveryHoldWarning(runtime, db, `run:${run.id}`)
    expect(receipt?.code).toBe('recipient_delivery_held')

    runtime.onPtyData(PTY_ID, '\x1b]7501;state=idle:app=codex\x07', 3)
    await vi.advanceTimersByTimeAsync(1000)
    foreground = 'codex'
    runtime.onPtyData(PTY_ID, '\x1b]0;another workspace shell title\x07', 4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
    foreground = 'zsh'

    // A shell can reuse the last agent's title without giving it the terminal's input.
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 5)
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: 0
    })
    expect((await sendDeliveryHoldWarning(runtime, db, `run:${run.id}`))?.code).toBe(
      'recipient_delivery_held'
    )

    const releaseShell = delayNextForegroundRead()
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 6)
    await vi.advanceTimersByTimeAsync(300)
    const delayedReceipt = sendDeliveryHoldWarning(runtime, db, `run:${run.id}`)
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'codex'
    // The return edge must survive an older shell sample that arrives afterward.
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 7)
    await vi.advanceTimersByTimeAsync(300)
    releaseShell()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await delayedReceipt).toBeNull()
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    expect(await sendDeliveryHoldWarning(runtime, db, `run:${run.id}`)).toBeNull()

    write.mockClear()
    const nextMessage = insertDirectRunMessage(db, run.id, 'Another worker finished')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(100)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message')
    ])
    foreground = 'zsh'
    await vi.advanceTimersByTimeAsync(1000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message')
    ])
    expect(db.getMessageById(nextMessage.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: 0
    })
    foreground = 'codex'
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 8)
    await vi.advanceTimersByTimeAsync(2000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(nextMessage.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })

    write.mockClear()
    const delayedEnterMessage = insertDirectRunMessage(db, run.id, 'Delayed foreground at Enter')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(100)
    foreground = 'zsh'
    const releaseEnterShell = delayNextForegroundRead()
    await vi.advanceTimersByTimeAsync(500)
    foreground = 'codex'
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 9)
    await vi.advanceTimersByTimeAsync(300)
    releaseEnterShell()
    await vi.advanceTimersByTimeAsync(2000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(delayedEnterMessage.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    db.close()
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

      expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toEqual({ kind: 'prompt' })
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
})
