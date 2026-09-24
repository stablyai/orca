import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { isHermesReadyPromptSnapshot } from './hermes-terminal-readiness'

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

  it('accepts nearby status and composer rows despite a changing footer', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })
    const { tail } = await runtime.readTerminal(handle, { screen: true })
    const rows = tail.join('\n').split('\n')
    const statusIndex = rows.findIndex((row) => /─ ready │/.test(row))
    expect(statusIndex).toBeGreaterThan(0)
    rows.splice(statusIndex + 1, 0, '20 background tasks')
    expect(isHermesReadyPromptSnapshot(rows.join('\n'))).toBe(true)
  })

  it('accepts bottom status bars, later turns without the banner, and named profiles', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })
    const { tail } = await runtime.readTerminal(handle, { screen: true })
    const rows = tail.join('\n').split('\n').filter(Boolean)
    const status = rows.find((row) => /─ ready │/.test(row))
    const composer = rows.find((row) => /^\s*❯ Try/.test(row))
    expect(status).toBeDefined()
    expect(composer).toBeDefined()
    expect(
      isHermesReadyPromptSnapshot(`recent output\nprofile-name ${composer!.trim()}\n${status}`)
    ).toBe(true)
    expect(isHermesReadyPromptSnapshot(`recent output\n${status}\n${composer}`)).toBe(true)
  })

  it('does not settle on a quoted prompt or a screen-owning dialog', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })
    const { tail } = await runtime.readTerminal(handle, { screen: true })
    const rows = tail.join('\n').split('\n')
    const statusIndex = rows.findIndex((row) => /─ ready │/.test(row))
    expect(statusIndex).toBeGreaterThan(0)
    rows.splice(statusIndex, 0, '⚠ approval required · Run this command?', '1. Allow once')
    expect(isHermesReadyPromptSnapshot(rows.join('\n'))).toBe(false)
    expect(isHermesReadyPromptSnapshot('old transcript\n─ ready │ model\n❯ help\nnew output')).toBe(
      false
    )
  })

  it('honors a fresh first-party approval state even if old pixels look ready', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]9999;{"state":"waiting","agentType":"hermes"}\x07',
      Date.now()
    )
    const screen = await runtime.readTerminal(handle, { screen: true })
    expect(isHermesReadyPromptSnapshot(screen.tail.join('\n'))).toBe(true)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]9999;{"state":"done","agentType":"hermes"}\x07',
      Date.now()
    )
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ satisfied: true })
  }, 4_000)

  it('rejects an old ready frame during a fresh model turn', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured
    })
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]9999;{"state":"working","agentType":"hermes"}\x07',
      Date.now()
    )
    const screen = await runtime.readTerminal(handle, { screen: true })
    expect(isHermesReadyPromptSnapshot(screen.tail.join('\n'))).toBe(true)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]9999;{"state":"done","agentType":"hermes"}\x07',
      Date.now()
    )
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ satisfied: true })
  }, 4_000)

  it('retries a visible read within a short waiter deadline', async () => {
    const readyOffset = captured.lastIndexOf('ready')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured.slice(0, readyOffset)
    })
    const read = vi.spyOn(runtime, 'readTerminal')
    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 800 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1), { timeout: 300 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, captured.slice(readyOffset), Date.now())
    await expect(waiting).resolves.toMatchObject({ satisfied: true })
    expect(
      read.mock.calls.filter(([, options]) => options?.screen === true).length
    ).toBeGreaterThan(1)
  }, 2_000)

  it('retries while a slow first screen read is still pending', async () => {
    const readyOffset = captured.lastIndexOf('ready')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      ptySize: { cols: 120, rows: 31 },
      data: captured.slice(0, readyOffset)
    })
    const originalRead = runtime.readTerminal.bind(runtime)
    const stale = await originalRead(handle, { screen: true })
    expect(isHermesReadyPromptSnapshot(stale.tail.join('\n'))).toBe(false)
    let screenReads = 0
    vi.spyOn(runtime, 'readTerminal').mockImplementation((...args) => {
      if (args[1]?.screen && ++screenReads === 1) {
        return new Promise((resolve) => setTimeout(() => resolve(stale), 750))
      }
      return originalRead(...args)
    })
    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 800 })
    await vi.waitFor(() => expect(screenReads).toBe(1), { timeout: 300 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, captured.slice(readyOffset), Date.now())
    await expect(waiting).resolves.toMatchObject({ satisfied: true })
    expect(screenReads).toBeGreaterThan(1)
  }, 2_500)

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
