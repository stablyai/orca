/** Quiet foreground is insufficient until the agent paints; use command-start markers to exclude shell prompts and launch echo. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  type TranscriptPaneOptions
} from './agent-transcript-pane-test-harness'

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

  it("does not take a reused pane's previous ready screen for the command now starting", async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      size: { cols: 80, rows: 24 },
      data: ''
    })
    vi.useFakeTimers()
    const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    const readyScreen = '─ ready │ 3s\r\n❯ Ask me anything…\r\n'
    const shellRunsHermes = '\x1b]133;A\x07~/repo % hermes\r\n\x1b]133;C\x07\x1b]0;hermes\x07'
    write(`${shellRunsHermes}${readyScreen}`)
    // The first Hermes exits; the shell starts a second one that has not painted yet.
    write(`\x1b]133;D;0\x07${shellRunsHermes}`)
    await runtime.readTerminal(handle, { screen: true })
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(settled).not.toHaveBeenCalled()

    write(readyScreen)
    await runtime.readTerminal(handle, { screen: true })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('ignores the exited Claude title at the shell and through the next launch until fresh paint', async () => {
    const pane: TranscriptPaneOptions = {
      paneTitle: 'Terminal',
      foregroundProcess: 'zsh',
      data: ''
    }
    const { runtime, handle } = await createTranscriptPane(pane)
    vi.useFakeTimers()
    const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    const composer = '\x1b]0;✳ Claude Code\x07\x1b[?2031h\x1b[?2004h│ ❯\u00a0 │\x1b[?25h'
    write('\x1b]133;A\x07~/repo % claude\r\n\x1b]133;C\x07\x1b]0;claude\x07')
    await vi.advanceTimersByTimeAsync(500)
    write(composer)
    await vi.advanceTimersByTimeAsync(5_000)
    // The first Claude exits; a wait starts before the shell has started the next one.
    write('\r\nResume this session with:\r\n\x1b]133;D;0\x07\x1b]133;A\x07~/repo % ')
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(settled).not.toHaveBeenCalled()

    pane.foregroundProcess = 'claude'
    write('claude\r\n\x1b]133;C\x07\x1b]0;claude\x07')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(settled).not.toHaveBeenCalled()

    write(composer)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
})
