import { readFileSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const startup = readFileSync(join(__dirname, '__fixtures__', 'cline-3-0-65-startup.txt'), 'utf8')

describe('Cline startup readiness', () => {
  it.each([false, true])(
    'captured composer respects an arriving working status: %s',
    async (working) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Cline',
        foregroundProcess: 'cline',
        launchAgent: 'cline',
        data: startup
      })
      const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
      await new Promise<void>((resolve) => terminal.write(startup, resolve))
      const buffer = terminal.buffer.active
      const tail = Array.from(
        { length: terminal.rows },
        (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
      )
      let reads = 0
      vi.spyOn(runtime, 'readTerminal').mockImplementation(async () => {
        if (working && ++reads === 2) {
          runtime.onPtyData(
            TRANSCRIPT_PANE_PTY_ID,
            '\x1b]9999;{"state":"working","agentType":"cline"}\x07',
            Date.now()
          )
        }
        return {
          handle,
          status: 'running',
          tail,
          truncated: false,
          nextCursor: null,
          source: 'screen'
        }
      })
      terminal.dispose()
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 4200 })
      await (working
        ? expect(wait).rejects.toThrow('timeout')
        : expect(wait).resolves.toMatchObject({ satisfied: true }))
    }
  )
})
