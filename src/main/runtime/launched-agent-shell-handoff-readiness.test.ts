/** Shells toggle bracketed paste around commands too; use post-handoff agent output, never shell prompts, for readiness. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

const QUIET_WINDOW_MS = 1_500
const SHELL_HANDOFF = '\x1b[?2004l'

function readFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

function shellRunsLaunchLine(): string {
  const zsh = readFixture('zsh-prompt-runs-command')
  const handoff = zsh.indexOf(SHELL_HANDOFF)
  return zsh.slice(0, zsh.indexOf('\n', handoff) + 1)
}

function shellPromptAfterCommandExits(): string {
  const zsh = readFixture('zsh-prompt-runs-command')
  return zsh.slice(zsh.indexOf('\n', zsh.indexOf(SHELL_HANDOFF)) + 1)
}

function launchedPane(
  options: {
    agent?: TuiAgent
    /** Whether the check proves a shell for this foreground name; default: only `zsh` does. */
    provesShell?: (name: string) => boolean
    checkDelayMs?: number
  } = {}
) {
  let listener = (_data: string): void => {}
  let foreground = 'zsh'
  let reads = 0
  const host = {
    getPtyId: () => 'pty-1',
    getForegroundProcess: async () => foreground,
    subscribeToData: (_ptyId: string, onData: (data: string) => void) => {
      listener = onData
      return () => {
        listener = () => {}
      }
    },
    readRecentOutput: () => undefined,
    write: vi.fn()
  }
  const provesShell = options.provesShell ?? ((name: string) => name === 'zsh')
  const ready = waitForWorktreeStartupDraft(host, 'term-1', options.agent ?? 'claude', {
    timeoutMs: 8_000,
    isShellInFront: async () => {
      reads += 1
      const name = foreground
      if (options.checkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.checkDelayMs))
      }
      return provesShell(name)
    }
  })
  const settled = vi.fn()
  void ready.then(settled)
  return {
    settled,
    get reads() {
      return reads
    },
    emit: (data: string) => listener(data),
    setForeground: (name: string) => {
      foreground = name
    }
  }
}

describe('a launched agent’s ready signal, after the shell that ran it', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for the agent’s own bracketed paste when the agent starts well after the shell’s prompt', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()
    const launchLine = shellRunsLaunchLine()
    expect(launchLine).toContain('\x1b[?2004h')

    pane.emit(launchLine)
    pane.setForeground('claude')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(pane.settled).not.toHaveBeenCalled()

    // Claude's composer marker answers once it draws, ahead of the quiet window.
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(100)
    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })

  it('never reads the shell’s next prompt as the agent’s composer after the agent exits', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit(shellRunsLaunchLine())
    pane.emit('claude: failed to start\r\n')
    pane.emit(shellPromptAfterCommandExits())
    await vi.advanceTimersByTimeAsync(8_000)

    expect(pane.settled).toHaveBeenCalledWith(null)
    expect(pane.reads).toBe(1)
  })

  // Unknown must retain the one-shot signal; only proven shell may discard it.
  it('settles on the signal when the check cannot prove a shell, with one read', async () => {
    vi.useFakeTimers()
    const pane = launchedPane({ provesShell: () => false })

    pane.emit(shellRunsLaunchLine())
    pane.setForeground('2.1.285')
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
    expect(pane.reads).toBe(1)
  })

  it('settles a Claude that is in front the moment its signal fires, with one check', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit(shellRunsLaunchLine())
    pane.setForeground('2.1.285')
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
    expect(pane.reads).toBe(1)
  })

  it('reads nothing before the signal when the shell never enables bracketed paste', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit('$ claude\r\n')
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(300)
    expect(pane.reads).toBe(0)
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
    expect(pane.reads).toBe(1)
  })

  // conda/pyenv startup subprocesses prove no agent; their following shell prompt must not settle readiness.
  it('does not settle while Claude is still silent after a startup-file subprocess ran', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.setForeground('python3.11')
    await vi.advanceTimersByTimeAsync(300)
    pane.setForeground('zsh')
    pane.emit(shellRunsLaunchLine())
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('counts only what follows the last hand-off when the shell draws two prompts first', async () => {
    vi.useFakeTimers()
    const pane = launchedPane({ provesShell: () => false })

    pane.emit(shellRunsLaunchLine())
    pane.emit(shellPromptAfterCommandExits())
    await vi.advanceTimersByTimeAsync(100)
    pane.emit(`claude${SHELL_HANDOFF}\r\r\n`)
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)
    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })

  it('sees a hand-off split across two chunks', async () => {
    vi.useFakeTimers()
    const pane = launchedPane({ provesShell: () => false })
    const launchLine = shellRunsLaunchLine()
    const cut = launchLine.indexOf(SHELL_HANDOFF) + 4

    pane.emit(launchLine.slice(0, cut))
    pane.emit(launchLine.slice(cut))
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)
    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })

  it('never settles a shell signal whose check was still running when the shell handed over', async () => {
    vi.useFakeTimers()
    const pane = launchedPane({ provesShell: () => false, checkDelayMs: 400 })
    const zsh = readFixture('zsh-prompt-runs-command')
    const handoff = zsh.indexOf(SHELL_HANDOFF)

    pane.emit(zsh.slice(0, handoff))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 100)
    expect(pane.reads).toBe(1)
    pane.emit(zsh.slice(handoff, zsh.indexOf('\n', handoff) + 1))
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('settles Codex 0.157 on its marker although it turns bracketed paste off and on as it starts', async () => {
    vi.useFakeTimers()
    const codex = readFixture('codex-0157-plain-ready')
    expect(codex).toContain(SHELL_HANDOFF)
    const pane = launchedPane({ agent: 'codex' })

    pane.emit(shellRunsLaunchLine())
    pane.setForeground('codex')
    pane.emit(codex)
    await vi.advanceTimersByTimeAsync(50)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })
})
