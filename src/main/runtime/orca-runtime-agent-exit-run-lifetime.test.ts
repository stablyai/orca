import { afterEach, describe, expect, it, vi } from 'vitest'
import { A, PTY, WT, fencedCapture, flush, makeAgentExitHost } from './agent-exit-host.test-fixture'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

const CLAUDE = { pid: 4242, platform: 'darwin' as const, startTime: 'utc:claude-start' }

afterEach(() => {
  vi.useRealTimers()
})

function unverifiable(ptyId: string): TerminalProcessInspection {
  return {
    foregroundProcess: 'tmux',
    hasChildProcesses: true,
    foregroundProcessEvidence: {
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId,
      ptyIncarnationId: `inc-${ptyId}`,
      verdict: 'unverifiable',
      reason: 'multiplexer_boundary'
    }
  }
}

function npmInFront(ptyId: string): TerminalProcessInspection {
  return {
    foregroundProcess: 'npm',
    hasChildProcesses: true,
    foregroundProcessEvidence: {
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId,
      ptyIncarnationId: `inc-${ptyId}`,
      verdict: 'live',
      processName: 'npm',
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: 'shell-start',
        tty: 'ttys001',
        foregroundPgid: 5005,
        process: { pid: 5005, startTime: 'npm-start' }
      }
    }
  }
}

describe('a later agent run in the same shell (R2-4)', () => {
  it('finds and proves a second Codex the hooks never announced, and records each end', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.alive.add(1001)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await flush()
    host.alive.delete(1001)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
    expect(host.recordProvenEnd).toHaveBeenCalledWith(
      expect.stringContaining(A),
      'codex',
      expect.any(Number)
    )

    // Codex B starts in the same shell (Codex hooks carry no PID, so no new owner signal).
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 2002, startTime: 'b' })
    host.alive.add(2002)
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    await vi.waitFor(() =>
      expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(2002)
    )

    host.alive.delete(2002)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
    await expect(host.chatSend(A, 'after-b-exit')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
  })
})

describe('identity discovery is bounded and scoped (R2-8, R2-11)', () => {
  it('looks again on recognized agent activity after a settled round, a few times only', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    await vi.advanceTimersByTimeAsync(10_000)
    const settled = host.inspectProcess.mock.calls.length
    expect(settled).toBe(3)
    // The agent execs late (slow rc, npx); its title then shows it working.
    host.foreground.set(PTY[A]!, { name: 'claude', pid: 3003, startTime: 'c' })
    host.alive.add(3003)
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(3003)

    // An agent that can never be identified: activity buys three single looks, then nothing.
    const other = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await other.published()
    await vi.advanceTimersByTimeAsync(10_000)
    for (let index = 0; index < 50; index += 1) {
      other.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(other.inspectProcess.mock.calls.length).toBe(6)
  })

  it('spends no capture on a hook start in a pane no client shows as chat', async () => {
    const host = makeAgentExitHost({ viewMode: 'terminal', leaves: 1 })
    await host.published()
    host.inspectProcess.mockClear()
    host.owner(A, { agent: 'codex' })
    await flush()
    expect(host.inspectProcess).not.toHaveBeenCalled()
    // Once a client switches it to chat, its agent is looked for.
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    await flush()
    expect(host.inspectProcess).toHaveBeenCalled()
  })
})

describe('an end that stays unverifiable backs off; change signals re-arm it, rate-limited (R2-6, R2-7, R3Y-1)', () => {
  it('costs at most three captures however many publishes follow', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    await vi.advanceTimersByTimeAsync(20_000)
    host.inspectProcess.mockClear()
    for (let index = 0; index < 200; index += 1) {
      host.runtime.touchMobileSessionTabsForWorktree(WT)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // Three end checks, plus one look-round for a next agent once the process is gone.
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3 + 3)
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.failedEndChecks).toBe(3)
    expect(host.hostPair().viewMode).toBe('chat')
  })

  it('under tmux, a stream of finished commands and title exits costs one look per 15 s at most', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    await vi.advanceTimersByTimeAsync(20_000)
    host.inspectProcess.mockClear()
    for (let index = 0; index < 300; index += 1) {
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      host.runtime['confirmPtyAgentExit'](PTY[A]!)
      host.runtime.touchMobileSessionTabsForWorktree(WT)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3 + 3 + 300 / 15)
    expect(host.hostPair().viewMode).toBe('chat')
  })

  it('asks an SSH relay again only on a change signal, at most once per 15 s', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-win' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    for (let index = 0; index < 300; index += 1) {
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(1 + 300 / 15)
  })

  it.each([
    ['the capture was unreadable (loaded machine)', unverifiable],
    ['a long non-agent command was in front', npmInFront]
  ])(
    'retires once the shell is back and a command finishes, after the checks ran out (%s)',
    async (_label, failing) => {
      vi.useFakeTimers()
      const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
      host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
      host.alive.add(1001)
      await host.published()
      host.owner(A, { agent: 'codex' })
      await vi.advanceTimersByTimeAsync(10)
      host.alive.delete(1001)
      host.inspectProcess.mockImplementation(async (ptyId: string) => failing(ptyId))
      host.runtime['confirmPtyAgentExit'](PTY[A]!)
      for (let index = 0; index < 36; index += 1) {
        host.runtime.touchMobileSessionTabsForWorktree(WT)
        await vi.advanceTimersByTimeAsync(5_000)
      }
      expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.failedEndChecks).toBe(3)
      // The shell is back in front; OSC 133;D reports the finished command.
      host.inspectProcess.mockImplementation(async (ptyId: string) =>
        fencedCapture(ptyId, `inc-${ptyId}`, null)
      )
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(host.hostPair().viewMode).toBe('terminal')
    }
  )

  it('retires an idle shell with slow timed follow-ups once the checks ran out, then refuses chat (R4Z-1)', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.alive.add(1001)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await vi.advanceTimersByTimeAsync(10)
    host.alive.delete(1001)
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    // The prompt's command-finished signal is spent while the machine is loaded.
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    host.runtime['nudgeAgentExitCheck'](PTY[A]!)
    for (let index = 0; index < 36; index += 1) {
      host.runtime.touchMobileSessionTabsForWorktree(WT)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.failedEndChecks).toBe(3)
    // Load gone, shell idle in front: no terminal activity and no publishes from here on.
    host.inspectProcess.mockImplementation(async (ptyId: string) =>
      fencedCapture(ptyId, `inc-${ptyId}`, null)
    )
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(host.hostPair().viewMode).toBe('terminal')
    expect(host.runtime['agentEndFollowUpTimers'].size).toBe(0)
    vi.useRealTimers()
    await expect(host.chatSend(A, 'after-exit')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
  })

  it('spends at most three timed follow-ups on a pane that stays unreadable, then no timer', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    await vi.advanceTimersByTimeAsync(20_000)
    host.inspectProcess.mockClear()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    const run = host.runtime['agentExitRuns'].current(PTY[A]!)
    expect(run?.endFollowUps).toBe(3)
    // Three discovery looks once the process is gone, plus the three follow-ups.
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3 + 3)
    expect(host.runtime['agentEndFollowUpTimers'].size).toBe(0)
    expect(host.hostPair().viewMode).toBe('chat')
  })

  it('finds a later Codex in the shell while the first exit is still unproven', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.alive.add(1001)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await vi.advanceTimersByTimeAsync(10)
    host.alive.delete(1001)
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    for (let index = 0; index < 36; index += 1) {
      host.runtime.touchMobileSessionTabsForWorktree(WT)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // Load gone; Codex B starts in the same shell (its hooks reuse the never-ended owner).
    host.inspectProcess.mockImplementation(async (ptyId: string) =>
      fencedCapture(ptyId, `inc-${ptyId}`, host.foreground.get(ptyId) ?? null)
    )
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 2002, startTime: 'b' })
    host.alive.add(2002)
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(2002)
    host.alive.delete(2002)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.hostPair().viewMode).toBe('terminal')
  })

  it('still confirms promptly when the ended agent was merely still in front', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
  })
})

describe('the proof and discovery chains never strand a run or reject unhandled (RD2-R1)', () => {
  it('reopens an end check whose replacement lookup throws, and a later signal still decides it', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 999, startTime: 'r' })
    host.bootstrap.mockRejectedValueOnce(new Error('ps exploded'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.endHandled).toBe(false)
    expect(warn).toHaveBeenCalledWith('[native-chat] agent exit check failed', expect.any(Error))
    host.foreground.set(PTY[A]!, null)
    await vi.advanceTimersByTimeAsync(20_000)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.advanceTimersByTimeAsync(10)
    expect(host.hostPair().viewMode).toBe('terminal')
    warn.mockRestore()
  })

  it('keeps discovering after a look throws', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.bootstrap.mockRejectedValueOnce(new Error('ps exploded'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await host.published()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(warn).toHaveBeenCalledWith('[native-chat] agent identity look failed', expect.any(Error))
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(1001)
    warn.mockRestore()
  })
})

describe('SSH end checks (R0107-1, R0107-2)', () => {
  it('re-checks once after a title exit that arrived while the first check still saw Claude', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-1' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    // SessionEnd lands while Claude is still in front on the remote host.
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    // Claude leaves and the title exit arrives while that relay check is still in flight.
    host.foreground.set(PTY[A]!, null)
    host.runtime['nudgeAgentExitCheck'](PTY[A]!)
    // Nothing failed, so nothing is backed off: the re-check runs right after the first (R5-1).
    await vi.advanceTimersByTimeAsync(10)
    expect(host.hostPair().viewMode).toBe('terminal')
    expect(host.probe).not.toHaveBeenCalled()
  })

  it('keeps the 15 s limit for signals during checks once a relay check came back unreadable', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-1' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.inspectProcess.mockImplementation(
      (ptyId: string) =>
        new Promise((resolve) => setTimeout(() => resolve(unverifiable(ptyId)), 500))
    )
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    for (let index = 0; index < 300; index += 1) {
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(200)
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(800)
    }
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(1 + 300 / 15)
    expect(host.hostPair().viewMode).toBe('chat')
  })

  it("never looks a remote replacement's PID up in this host's process table", async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-1' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 999, startTime: 'r' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    expect(host.bootstrap).not.toHaveBeenCalled()
    const run = host.runtime['agentExitRuns'].current(PTY[A]!)
    expect(run?.agent).toBe('codex')
    expect(run?.identity).toBeNull()
  })
})
