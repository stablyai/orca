import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PTY_ID,
  PANE_KEY,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { sendDeliveryHoldWarning } from '../../../rpc/methods/orchestration/messaging/send-delivery-hold'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

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
    let nextExitNameRead: Promise<void> | undefined
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
      confirmForegroundProcess: async () => {
        const sampled = foreground
        const delayed = nextExitNameRead
        nextExitNameRead = undefined
        await delayed
        return sampled
      },
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
    runtime.onPtyData(PTY_ID, '\x1b]0;another workspace shell title\x07', 4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })

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
    await vi.advanceTimersByTimeAsync(7000)
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

    write.mockClear()
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=clear\x07', 10)
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'zsh'
    let releaseExitName = (): void => {}
    nextExitNameRead = new Promise((resolve) => {
      releaseExitName = resolve
    })
    runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell after exit\x07', 11)
    await vi.advanceTimersByTimeAsync(300)
    const returnedMessage = insertDirectRunMessage(db, run.id, 'Mail during exit confirmation')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    foreground = 'codex'
    // An OSC-only return must invalidate the older exit sample without another title.
    const releaseReturnForeground = delayNextForegroundRead()
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=idle:app=codex\x07', 12)
    await vi.advanceTimersByTimeAsync(0)
    releaseExitName()
    await vi.advanceTimersByTimeAsync(0)
    releaseReturnForeground()
    await vi.advanceTimersByTimeAsync(2000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(returnedMessage.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    expect(await sendDeliveryHoldWarning(runtime, db, `run:${run.id}`)).toBeNull()
    db.close()
  })

  it.each([
    { shellKind: 'plain', launchAgent: null, longHold: false },
    { shellKind: 'title-setting', launchAgent: null, longHold: false },
    { shellKind: 'title-setting', launchAgent: 'claude' as const, longHold: true },
    { shellKind: 'title-setting', launchAgent: null, longHold: true }
  ])(
    'delivers after a silent foreground return ($shellKind, launch=$launchAgent, expired=$longHold)',
    async ({ shellKind, launchAgent, longHold }) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-silent-mail-return-')
      const receivedAt = Date.now()
      const { runtime } = createRuntime(db, {
        launchAgent,
        getAgentStatusSnapshot: () => [
          {
            paneKey: PANE_KEY,
            connectionId: null,
            agentType: 'claude',
            state: 'done',
            prompt: '',
            receivedAt,
            stateStartedAt: 1
          }
        ]
      })
      let shell = false
      let inspections = 0
      let echoSequence = 3
      const write = vi.fn((_ptyId: string, data: string) => {
        if (longHold) {
          const composer =
            data === '\r'
              ? readRuntimeFixture('claude-2-1-316-default-unlabelled-empty').replaceAll(
                  '\x1b]0;✳ Claude Code\x07',
                  ''
                )
              : `\x1b[2J\x1b[H\x1b[?25h${'─'.repeat(40)}\r\n❯ ${data.trim()}\r\n${'─'.repeat(40)}\x1b[2;${data.trim().length + 3}H`
          runtime.onPtyData(PTY_ID, composer, echoSequence++)
        }
        return true
      })
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getSize: () => ({ cols: 200, rows: 30 }),
        getForegroundProcess: async () => 'zsh',
        confirmShellForeground: async () => shell,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => {
          inspections++
          return {
            foregroundProcess: shell ? 'zsh' : 'claude',
            hasChildProcesses: !shell,
            foregroundObservation: {
              ptyId: PTY_ID,
              ptyIncarnationId: 'mailbox-incarnation',
              authorityGeneration: 'test',
              observationEpoch: 1,
              capturedAgeMs: 0,
              verdict: 'observed',
              source: 'pty-master',
              foregroundKind: shell ? 'shell' : 'non-shell',
              processName: shell ? 'zsh' : 'claude'
            }
          }
        }
      })
      const run = createBoundRun(db, 'Silent foreground return')
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, readRuntimeFixture('claude-2-1-316-default-unlabelled-empty'), 1)
      await vi.advanceTimersByTimeAsync(1000)
      shell = true
      if (shellKind === 'title-setting') {
        runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', 2)
        await vi.advanceTimersByTimeAsync(1000)
      }
      const message = insertDirectRunMessage(db, run.id, 'Silent resume')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
        kind: 'not-foreground'
      })
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 0
      })
      if (longHold) {
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
        expect(write).not.toHaveBeenCalled()
        expect(runtime.mailTerminal?.lastAgentStatus).toBeNull()
      }
      // Only the physical foreground changes; the hook timestamp remains expired and untouched.
      shell = false
      await vi.advanceTimersByTimeAsync(longHold ? 65000 : 12000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      const completedInspections = inspections
      await vi.advanceTimersByTimeAsync(65000)
      expect(write).toHaveBeenCalledTimes(2)
      expect(inspections).toBe(completedInspections)
      if (longHold) {
        expect(runtime.mailTerminal?.lastAgentStatus).toBeNull()
      }

      shell = true
      const second = insertDirectRunMessage(db, run.id, 'Fresh receipt')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
        kind: 'not-foreground',
        agentName: 'Claude'
      })
      shell = false
      expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toBeNull()
      await vi.advanceTimersByTimeAsync(7000)
      expect(db.getMessageById(second.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      expect(write).toHaveBeenCalledTimes(4)
      db.close()
    }
  )
})
