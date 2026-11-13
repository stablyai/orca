/** STA-2380: a shell auto-title names Claude before it draws anything; quiet alone must not make it ready. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  type TranscriptPaneOptions
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'
import { sendAgentTurn } from '../../orchestration/turn-delivery/send-agent-turn'
import type { TerminalProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
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
// A shell whose title carries the whole command line (oh-my-zsh's window title), as a pipeline or a one-shot.
const shellRunsTitled = (commandLine: string) =>
  `\x1b]133;A\x07~/repo % ${commandLine}\r\n\x1b]133;C\x07\x1b]0;${commandLine}\x07`
function inspectedForeground(processName: string | null): TerminalProcessInspection {
  return {
    foregroundProcess: processName,
    hasChildProcesses: true,
    foregroundObservation: processName
      ? {
          ptyId: TRANSCRIPT_PANE_PTY_ID,
          ptyIncarnationId: 'inc-1',
          authorityGeneration: 'host-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          verdict: 'observed',
          source: 'pty-master',
          foregroundKind: processName === 'zsh' ? 'shell' : 'non-shell',
          processName
        }
      : undefined
  }
}

const CLAUDE_HELP_TEXT =
  'Usage: claude [options] [command] [prompt]\r\n\r\nClaude Code - starts an interactive session by default\r\n'

async function startClaudePane(
  writes?: { data: string; at: number }[],
  identity: 'launched' | 'title-only' = 'launched',
  // Title-only panes: what the foreground probe sees; the shell while hooks run, or the live process.
  titleOnlyForeground = 'zsh',
  processInspection?: TerminalProcessInspection
) {
  // Title-only: no launch authority and a foreground probe that does not name an agent, as for an
  // adopted pane or a `claude` run through a command Orca does not recognize (STA-14925).
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: identity === 'launched' ? 'claude' : titleOnlyForeground,
    ...(identity === 'launched' ? { launchAgent: 'claude' as const } : {}),
    data: '',
    processInspection
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

  it('keeps holding a title-only Claude pane while the quiet foreground is Claude itself, not a pager', async () => {
    // Native Claude's foreground name is its node process; the probe must not relax the gate for it.
    const { runtime, handle, write } = await startClaudePane(undefined, 'title-only', 'node')
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

  it('settles a title-only pipeline on an observed unrelated foreground without a pager allowlist', async () => {
    const { runtime, handle, write } = await startClaudePane(
      undefined,
      'title-only',
      'fzf',
      inspectedForeground('fzf')
    )
    write(`${shellRunsTitled('claude --help | fzf')}${CLAUDE_HELP_TEXT}:`)
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it('keeps an identified noncomposer Claude pending until the shell command completes', async () => {
    const { runtime, handle, write } = await startClaudePane(
      undefined,
      'title-only',
      'claude',
      inspectedForeground('claude')
    )
    write(shellRunsTitled('claude --append-system-prompt "" mcp serve') + LATER_PREEXEC_HOOK_PRINTS)
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    wait.then(settled, () => {})
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(settled).not.toHaveBeenCalled()
    // In a title-only pane process discovery may still name the old process until its next scan.
    write('\x1b]133;D;0\x07\x1b]133;A\x07~/repo % ')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it.each(['claude --append-system-prompt-file ./prompt.md', 'claude --append-system-prompt ""'])(
    'holds `%s` without reconstructing the title argv',
    async (commandLine) => {
      const { runtime, handle, write } = await startClaudePane(undefined, 'title-only')
      write(shellRunsTitled(commandLine) + LATER_PREEXEC_HOOK_PRINTS)
      const settled = vi.fn()
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      wait.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
      expect(settled).not.toHaveBeenCalled()
      write(CLAUDE_COMPOSER_BARE_TITLE)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    }
  )

  it.each(['claude --bg', 'claude --background'])(
    'settles a title-only `%s` pane whose shell came back with the title retained; a background launch draws no composer (F41366-C3-2)',
    async (commandLine) => {
      // The launch prints its id and returns: command finish, a fresh prompt, and the old title.
      const { runtime, handle, write } = await startClaudePane(undefined, 'title-only', 'zsh')
      write(
        `${shellRunsTitled(commandLine)}${LATER_PREEXEC_HOOK_PRINTS}Started background session: 1a2b\r\n` +
          '\x1b]133;D;0\x07\x1b]133;A\x07~/repo % \x1b[?2004h'
      )
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    }
  )

  it('settles a bare-titled `claude` pane once the quiet foreground probe shows a pager (F41366-1)', async () => {
    // A tab title carries only the command word; the live foreground is what tells the pager apart.
    const { runtime, handle, write } = await startClaudePane(
      undefined,
      'title-only',
      'less',
      inspectedForeground('less')
    )
    write(`${SHELL_RUNS_CLAUDE}${CLAUDE_HELP_TEXT}:`)
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })

  it.each([null, 'zsh', 'error'])(
    'recovers from %s to an observed pager with no new output',
    async (initial) => {
      const inspection = inspectedForeground(initial === 'error' ? null : initial)
      let failing = initial === 'error'
      const pane: TranscriptPaneOptions = {
        paneTitle: 'Terminal',
        foregroundProcess: initial === 'error' ? null : initial,
        onProcessInspection: () => {
          if (failing) {
            throw new Error('temporary inspection failure')
          }
        },
        processInspection: inspection,
        data: ''
      }
      const { runtime, handle } = await createTranscriptPane(pane)
      vi.useFakeTimers()
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        `${SHELL_RUNS_CLAUDE}${CLAUDE_HELP_TEXT}:`,
        Date.now()
      )
      const settled = vi.fn()
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      wait.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
      expect(settled).not.toHaveBeenCalled()
      failing = false
      Object.assign(inspection, inspectedForeground('less'))
      pane.foregroundProcess = 'less'
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    }
  )
})

describe('adopted readiness observation budget', () => {
  afterEach(() => vi.useRealTimers())

  it.each([100, 1_000])(
    'bounds %i concurrent waiters by interested PTYs, including cancellation',
    async (count) => {
      const read = vi.fn()
      const inspection = inspectedForeground(null)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: null,
        data: '',
        processInspection: inspection,
        onProcessInspection: read
      })
      vi.useFakeTimers()
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        SHELL_RUNS_CLAUDE + LATER_PREEXEC_HOOK_PRINTS,
        Date.now()
      )
      const signals = Array.from({ length: count }, () => new AbortController())
      const waits = signals.map((controller) =>
        runtime
          .waitForTerminal(handle, {
            condition: 'tui-idle',
            timeoutMs: 120_000,
            signal: controller.signal
          })
          .catch(() => null)
      )
      await vi.advanceTimersByTimeAsync(10_000)
      signals[0].abort()
      await vi.advanceTimersByTimeAsync(50_000)
      // One PTY needs at most six attempts in 60s: immediate, then completion +2,+4,+8,+16,+16.
      // Adding callers and removing one never buys a separate observation budget.
      expect(read.mock.calls.length).toBeGreaterThan(0)
      expect(read.mock.calls.length).toBeLessThanOrEqual(6)
      const beforeCancel = read.mock.calls.length
      for (const signal of signals) {
        signal.abort()
      }
      await Promise.all(waits)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(read).toHaveBeenCalledTimes(beforeCancel)
      // Resubscribing must not reset an unresolved PTY's retry deadline.
      const next = new AbortController()
      const wait = runtime
        .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000, signal: next.signal })
        .catch(() => null)
      Object.assign(inspection, inspectedForeground('fzf'))
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    }
  )
})

describe('worker start on a slow-starting Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    'finished predecessor',
    'missing finish',
    'typed after prompt end',
    'split composer anchor'
  ])(
    'holds a replacement Claude and brief after %s despite a late Codex read',
    async (boundary) => {
      let foreground = 'codex'
      let defer = false
      let completeOld!: (name: string) => void
      const writes: string[] = []
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        data: '\x1b]133;C\x07\x1b]0;codex\x07',
        onWrite: (data) => writes.push(data),
        foregroundProcessRead: () =>
          defer
            ? ((defer = false),
              new Promise<string>((resolve) => {
                completeOld = resolve
              }))
            : Promise.resolve(foreground)
      })
      vi.useFakeTimers()
      expect(await runtime.isTerminalRunningSettledPromptAgent(handle)).toBe(true)
      defer = true
      const oldPresence = runtime.isTerminalRunningSettledPromptAgent(handle)
      foreground = 'zsh'
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        (boundary === 'finished predecessor' ? '\x1b]133;D;0\x07' : '') +
          (boundary === 'split composer anchor'
            ? '\x1b]0;claude\x07\x1b]133;B\x07\x1b]133;C\x07'
            : boundary === 'typed after prompt end'
              ? '\x1b]133;B\x07claude\r\n\x1b]133;C\x07\x1b]0;claude\x07'
              : SHELL_RUNS_CLAUDE) +
          (boundary === 'split composer anchor' ? '' : LATER_PREEXEC_HOOK_PRINTS),
        Date.now()
      )
      completeOld('codex')
      await expect(oldPresence).resolves.toBe(false)
      const delivered = runtime
        .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
        .then((ready) => {
          expect(ready.satisfied).toBe(true)
          return sendAgentTurn({
            kind: 'terminal',
            runtime,
            handle,
            turn: {
              purpose: 'dispatch-preamble',
              body: 'TASK: replacement brief',
              operationId: 'op-replacement'
            }
          })
        })
      delivered.catch(() => {})
      await vi.advanceTimersByTimeAsync(12_000)
      expect(writes).toEqual([])
      if (boundary === 'split composer anchor') {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b', Date.now())
        await vi.advanceTimersByTimeAsync(2_000)
        expect(writes).toEqual([])
      }
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        boundary === 'split composer anchor'
          ? CLAUDE_COMPOSER_BARE_TITLE.slice(1)
          : CLAUDE_COMPOSER_BARE_TITLE,
        Date.now()
      )
      await vi.advanceTimersByTimeAsync(16_000)
      await delivered
      expect(writes).toContainEqual(expect.stringContaining('TASK: replacement brief'))
    }
  )

  it.each(['launched', 'title-only'] as const)(
    'holds %s readiness and the brief until the composer exists',
    async (identity) => {
      const writes: { data: string; at: number }[] = []
      const { runtime, handle, write } = await startClaudePane(writes, identity)
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
    }
  )
})
