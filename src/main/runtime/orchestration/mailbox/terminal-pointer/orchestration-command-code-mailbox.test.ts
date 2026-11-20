import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  createBoundRun,
  createRuntime,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

// Command Code 1.91.1 titles its tab with the session and model only, never its turn (#45038).
const TITLE = '\x1b]0;⌘ Session · deepseek-v4.1-flash-(latest)\x07'
const TURN = '\r\n❯ ping: reply with a word\r\n✧ Thinking…\r\n'
const IDLE_COMPOSER = '\r\n❯ Ask your question...\r\n? for shortcuts'
const COMMAND_FINISHED = '\x1b]133;D;0\x07'
const SHELL_PROMPT = `\r\n${COMMAND_FINISHED}\x1b]133;A\x07PS C:\\repo> `
// Command Code's done candidate settles for 1.5 s before its composer counts as idle.
const SETTLE_MS = 2_000

async function startCommandCodeWorker(
  options: Parameters<typeof createRuntime>[1] = { launchAgent: 'command-code' }
) {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const { runtime, write } = await createRuntime(db, options)
  const run = createBoundRun(db, 'Command Code Run')
  runtime.noteTerminalSpawnCommand(PTY_ID, 'command-code --trust')
  await runtime.listTerminals()
  const feed = async (data: string): Promise<void> => {
    runtime.onPtyData(PTY_ID, data, Date.now())
    await runtime.serializeMainTerminalBuffer(PTY_ID)
  }
  await feed(TITLE)
  await feed(TURN)
  return { db, runtime, write, run, feed }
}

describe('Command Code mailbox delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('points a Command Code agent idle at its composer at queued mail', async () => {
    const { db, runtime, write, run, feed } = await startCommandCodeWorker()
    insertDirectRunMessage(db, run.id, 'pelican')
    expect(runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({ kind: 'unverified' })

    await feed(IDLE_COMPOSER)
    await vi.advanceTimersByTimeAsync(SETTLE_MS)

    expect(runtime.readTerminalMailHold(`run:${run.id}`)).toBeNull()
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    db.close()
  })

  it('points a Command Code agent already idle at its composer at a reply', async () => {
    const { db, runtime, write, run, feed } = await startCommandCodeWorker()
    await feed(IDLE_COMPOSER)
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    insertDirectRunMessage(db, run.id, 'pelican')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(runtime.readTerminalMailHold(`run:${run.id}`)).toBeNull()
    expect(pointerCount(write)).toBe(1)
    db.close()
  })

  it('does not point at a composer Command Code repaints during a tool step', async () => {
    const { db, runtime, write, run, feed } = await startCommandCodeWorker()
    insertDirectRunMessage(db, run.id, 'pelican')
    await feed(IDLE_COMPOSER)
    await vi.advanceTimersByTimeAsync(500)
    await feed('\r\n✧ Thinking…\r\n')
    await vi.advanceTimersByTimeAsync(SETTLE_MS)

    expect(runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({ kind: 'unverified' })
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('stops pointing at the pane once Command Code leaves the foreground under its title', async () => {
    let foregroundProcess: string | null = 'command-code'
    const { db, runtime, write, run, feed } = await startCommandCodeWorker({
      launchAgent: null,
      getForegroundProcess: async () => foregroundProcess
    })
    runtime.setForegroundAgent(PTY_ID, 'command-code')
    await feed(IDLE_COMPOSER)
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(runtime.agentStatus(PTY_ID)).toBe('idle')

    foregroundProcess = 'pwsh'
    await runtime.refreshPtyForegroundAgentFromController(PTY_ID)
    insertDirectRunMessage(db, run.id, 'pelican')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(runtime.readTerminalMailHold(`run:${run.id}`)).not.toBeNull()
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it.each([
    ['in its own chunk', [IDLE_COMPOSER, SHELL_PROMPT]],
    ['in the chunk that repaints its composer', [`${IDLE_COMPOSER}${SHELL_PROMPT}`]]
  ])(
    'stops pointing at the pane once Command Code exits %s under a title the shell never replaces',
    async (_case, chunks) => {
      const { db, runtime, write, run, feed } = await startCommandCodeWorker()
      // A foreground probe that has not yet seen the exit still names Command Code.
      runtime.setForegroundAgent(PTY_ID, 'command-code')
      for (const chunk of chunks) {
        await feed(chunk)
      }
      insertDirectRunMessage(db, run.id, 'pelican')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(5_000)

      expect(runtime.readTerminalMailHold(`run:${run.id}`)).not.toBeNull()
      expect(pointerCount(write)).toBe(0)
      db.close()
    }
  )

  it('leaves a seeded title of another agent unclassified when its pane finishes a command', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const { runtime, write } = await createRuntime(db, { launchAgent: null })
    const run = createBoundRun(db, 'Command Code Run')
    runtime.seedTitle(PTY_ID, '✳ Claude Code')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'pelican')
    runtime.onPtyData(PTY_ID, COMMAND_FINISHED, Date.now())
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(runtime.agentStatus(PTY_ID)).toBeNull()
    expect(runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({ kind: 'unverified' })
    expect(pointerCount(write)).toBe(0)
    db.close()
  })
})
