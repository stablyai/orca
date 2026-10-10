/**
 * An agent with no rest signal of its own (amp) settles only on a quiet foreground, and only
 * once it has painted. The shell's prompt and the echoed launch command land first, so the
 * runtime must tell them apart from the agent's paint by the shell's command-start marker.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const POLL_INTERVAL_MS = 2_000

describe('tui-idle on an agent with no rest signal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits through a silent boot after the shell echoed the command, then settles on the paint', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'amp',
      launchAgent: 'amp',
      data: ''
    })
    vi.useFakeTimers()
    const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    write('\x1b]133;A\x07~/repo % amp\r\n\x1b]133;C\x07\x1b]0;amp\x07')
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(settled).not.toHaveBeenCalled()

    write('\x1b[?1049h\x1b[H╭─ Amp ─╮\r\n│ > │')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('does not finish a command-start marker cut off by dropped output', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'amp',
      launchAgent: 'amp',
      data: ''
    })
    vi.useFakeTimers()
    const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    // Fish's marker carries the command line, so a cut-off one can terminate on unrelated output.
    write('~/repo % amp\r\n\x1b]133;C;cmdline_url=am')
    runtime.notePtyDataGap(TRANSCRIPT_PANE_PTY_ID, 4096)
    write('╭─ Amp ─╮\r\n│ > │\x1b]0;amp\x07')
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
})
