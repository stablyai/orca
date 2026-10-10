/**
 * A shell that titles the command it is about to run (zsh preexec auto-title) writes the agent's
 * bare name before the agent's TUI has mounted. For an agent whose only rest signal is that name,
 * the title alone used to settle `tui-idle`, so a launch pasted its prompt into a TUI still
 * booting, or into the shell. A launch readiness wait holds that title to a quiet stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const BOOT_FRAME = 'Loading…\r\n'

/** The shell echoes the launch line, then its preexec hook titles the pane with the command. */
async function launchedPaneTitledByShell(agent: 'gemini' | 'copilot') {
  return createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: agent,
    launchAgent: agent,
    data: `$ ${agent}\r\n${ESC}]2;${agent}${BEL}`
  })
}

/** The agent is still painting its boot screen: output keeps arriving each second. */
async function keepBooting(
  runtime: Awaited<ReturnType<typeof launchedPaneTitledByShell>>['runtime'],
  seconds: number
): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, BOOT_FRAME, Date.now())
    await vi.advanceTimersByTimeAsync(1000)
  }
}

describe('a launch waiting on an agent whose shell titled the pane with its name', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Gemini's bare name was once normalized into its rest glyph; Copilot's name is its only signal.
  it.each(['gemini', 'copilot'] as const)(
    'does not treat the shell’s auto-title as readiness while %s is still booting',
    async (agent) => {
      const { runtime, handle } = await launchedPaneTitledByShell(agent)
      const settled = vi.fn()
      runtime
        .waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: 60_000,
          launchReadiness: true
        })
        .then(settled, settled)

      await keepBooting(runtime, 10)

      expect(settled).not.toHaveBeenCalled()
    }
  )

  it('settles once the agent’s stream goes quiet under that title', async () => {
    const { runtime, handle } = await launchedPaneTitledByShell('gemini')
    const settled = vi.fn()
    runtime
      .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000, launchReadiness: true })
      .then(settled, settled)

    await keepBooting(runtime, 4)
    await vi.advanceTimersByTimeAsync(8_000)

    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
  })

  it('keeps settling a later, non-launch wait on the name alone, as agents that never quiet need', async () => {
    const { runtime, handle } = await launchedPaneTitledByShell('gemini')
    const settled = vi.fn()
    runtime
      .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      .then(settled, settled)

    await keepBooting(runtime, 10)

    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
  })
})
