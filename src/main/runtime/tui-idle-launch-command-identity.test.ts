/**
 * A command Orca launched has to show it is up before tui-idle may settle. An unknown one has to
 * paint, and once it paints its foreground process names the agent it really is (a flagged
 * launch, or a wrapper that execs one), so that agent's own lanes decide. Settling on the first
 * quiet poll let the next prompt land in a TUI that was still booting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

// A runtime-hosted agent is named from its command line, which tests cannot read from a real PTY.
vi.mock('./local-pty-foreground-command-line', () => ({
  readLocalPtyForegroundCommandLine: async () => 'node /opt/agents/bin/codex --full-auto'
}))

const POLL_INTERVAL_MS = 2_000

async function launch(command: string | undefined, foregroundProcess: string) {
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess,
    data: '',
    ...(command ? { command } : {})
  })
  vi.useFakeTimers()
  const settled = vi.fn()
  const wait = pane.runtime.waitForTerminal(pane.handle, {
    condition: 'tui-idle',
    timeoutMs: 60_000
  })
  wait.then(settled, () => {})
  const write = (chunk: string) => pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
  return { ...pane, wait, settled, write }
}

const MARKED_LAUNCH = (command: string) => `\x1b]133;A\x07~/repo % ${command}\r\n\x1b]133;C\x07`
const CODEX_READY_TITLE = '\x1b]0;Codex ready\x07'

describe('tui-idle on a command Orca launched', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not settle a flagged agent launch that has painted nothing', async () => {
    const pane = await launch('omp --thinking high', 'omp')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('does not settle a flagged agent on its splash once its process names it', async () => {
    const command = 'codex -c model_reasoning_effort="high"'
    const pane = await launch(command, 'codex')
    pane.write(`${MARKED_LAUNCH(command)}\x1b[?1049h\x1b[H>_ codex starting`)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('settles a flagged agent on its own rest signal', async () => {
    const command = 'codex --full-auto'
    const pane = await launch(command, 'codex')
    pane.write(`${MARKED_LAUNCH(command)}\x1b[?1049h\x1b[H>_ codex starting`)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write(CODEX_READY_TITLE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })

  it('reads a launched wrapper that execs a runtime-hosted agent as that agent', async () => {
    // The launch command names only the wrapper, the process only the runtime; its command line
    // names the agent.
    const pane = await launch('/opt/agents/codex-wrapper', 'node')
    pane.write(`${MARKED_LAUNCH('/opt/agents/codex-wrapper')}\x1b[?1049h\x1b[H>_ codex starting`)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write(CODEX_READY_TITLE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })

  it('waits for an unknown command to paint, then settles once it is quiet', async () => {
    const pane = await launch('my-tool --serve', 'my-tool')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write(MARKED_LAUNCH('my-tool --serve'))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write('my-tool ready> ')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })

  it.each([
    ['notes-editor README.md', 'notes-editor', '\x1b[?1049h\x1b[H# README\r\n~\r\n~'],
    ['log-pager -R build.log', 'log-pager', '\x1b[?1049h\x1b[Hbuild ok\r\n(END)']
  ])(
    'settles a full-screen %s once it has painted and gone quiet',
    async (command, process, paint) => {
      const pane = await launch(command, process)
      pane.write(`${MARKED_LAUNCH(command)}${paint}`)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

      await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
    }
  )

  it.each([['codex'], ['log-pager']])(
    'keeps settling a pane Orca did not launch on a quiet %s foreground',
    async (process) => {
      const pane = await launch(undefined, process)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)

      await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
    }
  )
})
