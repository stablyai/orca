import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Muse readiness from captured terminal bytes', () => {
  it('recognizes a ready folder workspace without a skills summary', async () => {
    const data = readFileSync(
      join(__dirname, '__fixtures__', 'muse-empty-folder-ready.txt'),
      'utf8'
    )
    expect(data).toContain(String.fromCharCode(27))
    expect(data).not.toContain('Skills:')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'muse-first-class-workspace',
      foregroundProcess: 'muse-bin-1.3.0-R3401.1',
      launchAgent: 'muse',
      data
    })
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 10_000 })
    ).resolves.toMatchObject({ satisfied: true })
  }, 15_000)
})
