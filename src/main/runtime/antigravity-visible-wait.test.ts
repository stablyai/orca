import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Antigravity adopted-terminal visible readiness probe', () => {
  for (const connectionId of [undefined, 'ssh-host']) {
    it.each([
      ['antigravity-ready-default-127', true],
      ['antigravity-ready-plan-127', true],
      ['antigravity-composer-multiline-unsent', false],
      ['antigravity-dialog-model-picker', false],
      ['antigravity-busy-mid-turn', false]
    ] as const)(`${connectionId ?? 'local'}: %s ready=%s`, async (name, ready) => {
      const emulator = new HeadlessEmulator({ cols: 120, rows: 40, scrollback: 0 })
      try {
        await emulator.write(readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8'))
        const screen = projectTerminalVisibleLines(emulator)
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'agy',
          foregroundProcess: 'agy',
          data: '',
          connectionId
        })
        const read = vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
          handle,
          status: 'running',
          tail: screen.lines,
          draft: screen.draft,
          source: 'screen',
          truncated: false,
          limited: false,
          oldestCursor: '0',
          nextCursor: '0',
          latestCursor: '0',
          returnedLineCount: screen.lines.length
        })
        const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 600 })
        await (ready
          ? expect(waiting).resolves.toMatchObject({ satisfied: true })
          : expect(waiting).rejects.toThrow('timeout'))
        expect(read).toHaveBeenCalledWith(
          handle,
          {},
          expect.objectContaining({ visibleScreenOnly: true })
        )
      } finally {
        emulator.dispose()
      }
    })
  }

  it('does not accept a snapshot that finishes after losing contact with its host', async () => {
    const emulator = new HeadlessEmulator({ cols: 120, rows: 40, scrollback: 0 })
    try {
      await emulator.write(
        readFileSync(join(__dirname, '__fixtures__', 'antigravity-ready-default-127.txt'), 'utf8')
      )
      const screen = projectTerminalVisibleLines(emulator)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'agy',
        foregroundProcess: 'agy',
        data: '',
        connectionId: 'ssh-host'
      })
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const read = vi.spyOn(runtime, 'readTerminal').mockImplementation(async () => {
        await pending
        return {
          handle,
          status: 'running',
          tail: screen.lines,
          draft: screen.draft,
          source: 'screen',
          truncated: false,
          limited: false,
          oldestCursor: '0',
          nextCursor: '0',
          latestCursor: '0',
          returnedLineCount: screen.lines.length
        }
      })
      const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 600 })
      const outcome = expect(waiting).rejects.toThrow('timeout')
      expect(read).toHaveBeenCalled()
      runtime.markPtyLivenessUnverifiable(TRANSCRIPT_PANE_PTY_ID, 'SSH transport disconnected')
      release()
      await outcome
    } finally {
      emulator.dispose()
    }
  })
})
