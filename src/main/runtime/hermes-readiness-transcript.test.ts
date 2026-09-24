import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const captured = readFileSync(join(__dirname, '__fixtures__', 'hermes-tui-ready.txt'), 'utf8')

describe('Hermes TUI readiness from a captured PTY', () => {
  it('recognizes the ready input screen even when the retained PTY tail does not', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })

    const screen = await runtime.readTerminal(handle, { screen: true })
    expect(screen.source).toBe('screen')
    expect(screen.tail.join('\n')).toMatch(/Hermes Agent/i)
    expect(screen.tail.join('\n')).toMatch(/\bready\s*│/i)

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ satisfied: true })
  }, 5_000)

  it('waits for a ready screen that appears after the first visible read', async () => {
    const readyOffset = captured.lastIndexOf('ready')
    expect(readyOffset).toBeGreaterThan(0)
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured.slice(0, readyOffset)
    })

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3_500 })
    let settled = false
    void waiting.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(settled).toBe(false)

    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, captured.slice(readyOffset), Date.now())
    const screen = await runtime.readTerminal(handle, { screen: true })
    expect(screen.tail.join('\n')).toMatch(/\bready\s*│/i)
    await expect(waiting).resolves.toMatchObject({ satisfied: true })
  }, 6_000)

  it('does not treat a working status line and visible composer as idle', async () => {
    const readyOffset = captured.lastIndexOf('ready')
    const working = `${captured.slice(0, readyOffset)}working${captured.slice(readyOffset + 5)}`
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: working
    })
    const screen = await runtime.readTerminal(handle, { screen: true })
    expect(screen.tail.join('\n')).toMatch(/\bworking\s*│/i)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
  }, 3_000)
})
