import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('mailbox delivery with current adopted agent evidence', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
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
