/** STA-2380: a shell auto-title names Claude before it draws anything; quiet alone must not make it ready. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

const POLL_INTERVAL_MS = 2_000
// Shell integration's prompt and command-start markers, then oh-my-zsh's preexec title for `claude`.
const SHELL_RUNS_CLAUDE = '\x1b]133;A\x07~/repo % claude\r\n\x1b]133;C\x07\x1b]0;claude\x07'
// Claude's terminal-capability probe: output with nothing visible on screen.
const CLAUDE_CAPABILITY_PROBE = '\x1b[?u\x1b]11;?\x1b\\\x1b[c'

async function startClaudePane() {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    data: ''
  })
  vi.useFakeTimers()
  const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
  return { runtime, handle, write }
}

describe('tui-idle on a slow-starting Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not settle on the shell auto-title while Claude has painted nothing', async () => {
    const { runtime, handle, write } = await startClaudePane()
    write(SHELL_RUNS_CLAUDE)
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    write(CLAUDE_CAPABILITY_PROBE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(settled).not.toHaveBeenCalled()

    // The composer mounts with Claude's own rest title.
    write('\x1b]0;✳ Claude Code\x07\x1b[?2004h╭──────╮\r\n│ ❯\u00a0 │\r\n╰──────╯')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
})
