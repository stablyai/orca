import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Why: the grid-trust check and raw rows belong to screen-ruled agents; every other agent must
// keep reading the screen exactly as it did before them.
describe('screen-rule trust stays with screen-ruled agents', () => {
  it('a Codex pane still settles from its screen when the PTY reports another grid', async () => {
    const options = {
      paneTitle: 'Terminal',
      foregroundProcess: 'codex',
      launchAgent: 'codex' as const,
      // Only the live screen shows this recording's header (STA-8628): the text reads `dirctory:`.
      data: readRuntimeFixture('codex-0157-effort-override-embedded-warning'),
      size: { cols: 120, rows: 40 }
    }
    const { runtime, handle } = await createTranscriptPane(options)
    await runtime.readTerminal(handle, { screen: true })
    options.size = { cols: 100, rows: 30 }
    await expect(waitForTranscriptIdle({ runtime, handle }, 8_000)).resolves.toMatchObject({
      condition: 'tui-idle',
      satisfied: true
    })
  }, 20_000)
})
