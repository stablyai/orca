/** Quiet foreground is insufficient until the agent paints; use command-start markers to exclude shell prompts and launch echo. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalRead } from '../../../../shared/runtime-terminal-contracts'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

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

  it('uses only the current invocation status across coalesced and split shell boundaries', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'zsh',
      data: ''
    })
    vi.useFakeTimers()
    const ingest = (data: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
    const start = '\x1b]133;C\x07\x1b]0;claude\x07hook text\r\n'
    const idle = '\x1b]7501;state=idle:app=claude-code\x07'
    const working = '\x1b]7501;state=working:app=claude-code\x07'
    const end = '\x1b]133;D;0\x07\x1b]133;A\x07'
    ingest(start + idle)
    await expect(runtime.waitForTerminal(handle, { condition: 'tui-idle' })).resolves.toMatchObject(
      { satisfied: true }
    )

    // A genuine replacement also retires working, even when the previous D was lost.
    ingest(working + start)
    const firstSettled = vi.fn()
    const first = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    first.then(firstSettled, () => {})
    await vi.advanceTimersByTimeAsync(12_000)
    expect(firstSettled).not.toHaveBeenCalled()
    // A current program's live rest signal is sufficient without the Claude composer marker.
    ingest(idle)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(first).resolves.toMatchObject({ satisfied: true })

    ingest(idle + end + start.slice(0, 6))
    ingest(start.slice(6))
    const secondSettled = vi.fn()
    const second = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    second.then(secondSettled, () => {})
    await vi.advanceTimersByTimeAsync(12_000)
    expect(secondSettled).not.toHaveBeenCalled()
    ingest(end + start + idle)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(second).resolves.toMatchObject({ satisfied: true })
    ingest(start + idle)
    await expect(runtime.waitForTerminal(handle, { condition: 'tui-idle' })).resolves.toMatchObject(
      { satisfied: true }
    )
    const hookReady = '\x1b]9999;{"state":"done","sessionBoundary":true,"agentType":"claude"}\x07'
    // A stripped hook is still real output between BC and a possible app-zone D.
    ingest(`\x1b]133;B\x07\x1b]133;C\x07${hookReady}`)
    await expect(runtime.waitForTerminal(handle, { condition: 'tui-idle' })).resolves.toMatchObject(
      { satisfied: true }
    )
    ingest(hookReady + start)
    const thirdSettled = vi.fn()
    const third = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    third.then(thirdSettled, () => {})
    await vi.advanceTimersByTimeAsync(12_000)
    expect(thirdSettled).not.toHaveBeenCalled()
    ingest(hookReady + idle)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(third).resolves.toMatchObject({ satisfied: true })
  })

  it('retires readiness across an output gap that hides exit and the next command start', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'zsh',
      data: ''
    })
    vi.useFakeTimers()
    const ingest = (data: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
    ingest('\x1b]7501;state=done:app=claude-code\x07')
    await expect(runtime.waitForTerminal(handle, { condition: 'tui-idle' })).resolves.toMatchObject(
      { satisfied: true }
    )

    runtime.notePtyDataGap(TRANSCRIPT_PANE_PTY_ID, 4096)
    ingest('next invocation hook text\r\n')
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})
    await vi.advanceTimersByTimeAsync(12_000)
    expect(settled).not.toHaveBeenCalled()
    ingest('\x1b]7501;state=idle:app=claude-code\x07')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('discards a predecessor visible read after a genuine new command, then accepts current readiness', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'zsh',
      data: ''
    })
    vi.useFakeTimers()
    let finishRead: ((read: RuntimeTerminalRead) => void) | undefined
    const read = vi.spyOn(runtime, 'readTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    const settled = vi.fn()
    const idle = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    idle.then(settled, () => {})
    expect(read).toHaveBeenCalled()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]133;C\x07\x1b]0;claude\x07new hook\r\n',
      Date.now()
    )
    finishRead?.({
      handle,
      status: 'running',
      source: 'screen',
      tail: [
        'OpenAI Codex (v0.157.0)',
        'model: gpt-6.1-sol',
        'directory: /repo/app',
        '· /model to change'
      ],
      truncated: false,
      nextCursor: null
    })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(settled).not.toHaveBeenCalled()
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[?2031h\x1b[?2004h❯\u00a0', Date.now())
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(idle).resolves.toMatchObject({ satisfied: true })
    read.mockRestore()
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
