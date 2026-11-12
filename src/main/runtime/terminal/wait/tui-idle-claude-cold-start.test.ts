/** STA-2380: a shell auto-title names Claude before it draws anything; quiet alone must not make it ready. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'
import { sendAgentTurn } from '../../orchestration/turn-delivery/send-agent-turn'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

const POLL_INTERVAL_MS = 2_000
// Shell integration's prompt and command-start markers, then oh-my-zsh's preexec title for `claude`.
const SHELL_RUNS_CLAUDE = '\x1b]133;A\x07~/repo % claude\r\n\x1b]133;C\x07\x1b]0;claude\x07'
// A later preexec hook (zsh-you-should-use) prints after Orca's marker hook and before Claude runs.
const LATER_PREEXEC_HOOK_PRINTS =
  '\x1b[33mFound existing alias for "claude". You should use: "cc"\x1b[0m\r\n'
// Claude's terminal-capability probe: output with nothing visible on screen.
const CLAUDE_CAPABILITY_PROBE = '\x1b[?u\x1b]11;?\x1b\\\x1b[c'
// Claude's composer under the shell's bare title: palette reports on, paste mode on, `❯`+NBSP.
const CLAUDE_COMPOSER_BARE_TITLE = '\x1b[?2031h\x1b[?2004h╭──────╮\r\n│ ❯  │\r\n╰──────╯\x1b[?25h'

async function startClaudePane(
  writes?: { data: string; at: number }[],
  identity: 'launched' | 'title-only' = 'launched'
) {
  // Title-only: no launch authority and a foreground probe that still sees the shell, as for an
  // adopted pane or a `claude` run through a command Orca does not recognize (STA-14925).
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: identity === 'launched' ? 'claude' : 'zsh',
    ...(identity === 'launched' ? { launchAgent: 'claude' as const } : {}),
    data: ''
  })
  if (writes) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness's own controller, re-set with a recording write.
    const { ptyController } = runtime as unknown as { ptyController: RuntimePtyController }
    runtime.setPtyController({
      ...ptyController,
      write: (_ptyId, data) => {
        writes.push({ data, at: Date.now() })
        return true
      }
    })
  }
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
    write('\x1b]0;✳ Claude Code\x07\x1b[?2004h╭──────╮\r\n│ ❯  │\r\n╰──────╯')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('does not settle on text a later preexec hook printed before Claude ran (C1 F1)', async () => {
    const { runtime, handle, write } = await startClaudePane()
    write(SHELL_RUNS_CLAUDE + LATER_PREEXEC_HOOK_PRINTS)
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(settled).not.toHaveBeenCalled()

    // Claude mounts its composer but the title stays the shell's bare name (title disabled).
    write(CLAUDE_COMPOSER_BARE_TITLE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('does not settle a title-only Claude pane on text a later preexec hook printed (STA-14925)', async () => {
    const { runtime, handle, write } = await startClaudePane(undefined, 'title-only')
    write(SHELL_RUNS_CLAUDE + LATER_PREEXEC_HOOK_PRINTS)
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(settled).not.toHaveBeenCalled()

    write(CLAUDE_COMPOSER_BARE_TITLE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
})

describe('worker start on a slow-starting Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds readiness and the brief until the composer exists, despite preexec hook text', async () => {
    const writes: { data: string; at: number }[] = []
    const { runtime, handle, write } = await startClaudePane(writes)
    write(SHELL_RUNS_CLAUDE + LATER_PREEXEC_HOOK_PRINTS)

    // Worker start: readiness race (tui-idle launch lane vs. composer marker), then the dispatch's brief.
    let readyAt: number | null = null
    const delivered = waitForWorkerStartComposer(runtime, handle, 'claude', 60_000).then(
      (ready) => {
        readyAt = Date.now()
        expect(ready.satisfied).toBe(true)
        return sendAgentTurn({
          kind: 'terminal',
          runtime,
          handle,
          turn: { purpose: 'dispatch-preamble', body: 'TASK: brief', operationId: 'op-1' }
        })
      }
    )
    delivered.catch(() => {})

    // A whole silent cold start: nothing may reach the PTY while Claude has no composer.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6)
    expect(readyAt).toBeNull()
    expect(writes).toEqual([])

    const composerAt = Date.now()
    write(CLAUDE_COMPOSER_BARE_TITLE)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 8)
    await delivered
    expect(readyAt).not.toBeNull()
    expect(readyAt!).toBeGreaterThanOrEqual(composerAt)
    const brief = writes.find((entry) => entry.data.includes('TASK: brief'))
    expect(brief).toBeDefined()
    expect(brief!.at).toBeGreaterThanOrEqual(composerAt)
  })
})
