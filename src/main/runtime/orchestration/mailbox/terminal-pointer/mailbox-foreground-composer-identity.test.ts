import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  sqliteFor,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { readTimedRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))
const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('admits newer eligible mail through the discovered agent-specific composer without replaying uncertainty', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  const db = createDatabase('orca-mail-composer-identity-')
  const { runtime, write } = createRuntime(db, { launchAgent: null })
  const timed = readTimedRuntimeFixture('opencode-2-0-21-timed-narrow-pane')
  const ready = timed.chunks.filter((_, i) => timed.times[i] < timed.promptSentAtMs! - 600).join('')
  let shell = true
  runtime.setPtyController({
    write,
    kill: vi.fn(),
    getSize: () => ({ cols: 40, rows: 40 }),
    getForegroundProcess: async () => 'zsh',
    supportsForegroundObservation: () => true,
    inspectProcess: async () => ({
      foregroundProcess: shell ? 'zsh' : 'opencode2',
      hasChildProcesses: !shell,
      foregroundObservation: {
        ptyId: PTY_ID,
        ptyIncarnationId: 'mailbox-incarnation',
        authorityGeneration: 'synthetic-host',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: shell ? 'shell' : 'non-shell',
        processName: shell ? 'zsh' : 'opencode2'
      }
    }),
    writeWithSettlement: (ptyId, text) => {
      write(ptyId, text)
      const parts = text.trim().match(/.{1,28}/g) ?? ['']
      runtime.onPtyData(
        PTY_ID,
        text === '\r'
          ? `\x1b[2J\x1b[H${ready}`
          : `\x1b[2J\x1b[HOpenCode\r\n   ┃\r\n${parts.map((part) => `   ┃  ${part}`).join('\r\n')}\r\n   ┃\r\n   ┃  Build · gpt-6.1\r\n   ╹▀▀▀▀▀▀▀▀\x1b[3;7H\x1b[?25h`,
        Date.now()
      )
      return { outcome: 'accepted' }
    }
  })
  try {
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, `${ready}\x1b]0;/tmp/title-setting-shell\x07`, Date.now())
    const run = createBoundRun(db, 'Missing composer identity')
    const uncertain = insertDirectRunMessage(db, run.id, 'Previously staged; outcome unknown')
    sqliteFor(db)
      .prepare(`UPDATE messages SET pointer_enter_pending = 2,
      pointer_pty_id = ?, pointer_process_incarnation = ? WHERE id = ?`)
      .run(PTY_ID, 'pty-mailbox:mailbox-incarnation', uncertain.id)
    const fresh = insertDirectRunMessage(db, run.id, 'New eligible mail')
    expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
      kind: 'not-foreground'
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    shell = false
    runtime.onPtyData(PTY_ID, `\x1b[2J\x1b[H${ready}`, Date.now())
    await vi.advanceTimersByTimeAsync(125000)
    expect(write.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    expect(db.getMessageById(fresh.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    expect(db.getMessageById(uncertain.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: 2
    })
    await vi.advanceTimersByTimeAsync(600000)
    expect(write).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})
