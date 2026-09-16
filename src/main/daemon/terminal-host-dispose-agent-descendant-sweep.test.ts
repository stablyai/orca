import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

const runWslGuestTreeKillMock = vi.hoisted(() => vi.fn())
vi.mock('./wsl-guest-tree-kill', () => ({
  runWslGuestTreeKill: runWslGuestTreeKillMock
}))

function createMockAgentSubprocess(): SubprocessHandle & { exit: (code: number) => void } {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 99999,
    exit: (code: number) => onExit?.(code),
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  } as unknown as SubprocessHandle & { exit: (code: number) => void }
}

function sweepDeps(): {
  ownsRoot?: unknown
  awaitEscalation?: unknown
  sweepTimeoutMs?: unknown
  expectedRootCreationTimeMs?: unknown
} {
  // Why last call, not first: this file issues one sweep per test without a
  // mock reset, so calls[0] belongs to an earlier test.
  const lastCall = killWithDescendantSweepMock.mock.calls.at(-1)
  if (!lastCall) {
    throw new Error('expected a sweep call')
  }
  return lastCall[2] as {
    ownsRoot?: unknown
    awaitEscalation?: unknown
    sweepTimeoutMs?: unknown
    expectedRootCreationTimeMs?: unknown
  }
}

describe('TerminalHost dispose agent descendant sweep', () => {
  it('sweeps an agent session descendant tree before force-killing it on dispose', async () => {
    const subprocess = createMockAgentSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    await host.createOrAttach({
      sessionId: 'agent-1',
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    // The real killWithDescendantSweep always invokes killRoot exactly once
    // (POSIX and Windows branches both call it from a `finally`); simulate
    // that here rather than the default no-op stub.
    killWithDescendantSweepMock.mockImplementationOnce(async (_pid, killRoot) => {
      killRoot()
    })

    await host.dispose()

    // Why: an agent's tool children live in a detached process group that a
    // daemon quit's force-kill of the shell alone would orphan (#16367-style
    // leak, but for local terminal agents rather than agent-browser daemons).
    // Snapshotting before the force-kill below matters: once the root exits,
    // surviving descendants reparent to pid 1 and drop out of the ppid walk.
    // awaitEscalation must be set: without it, the daemon process can exit
    // before the descendant sweep's grace-window SIGKILL escalation fires,
    // leaving SIGTERM-ignoring tool children alive.
    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      99999,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function), awaitEscalation: true })
    )
    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })

  it('force-kills the agent root via killRoot immediately, without waiting for the descendant sweep to settle', async () => {
    const subprocess = createMockAgentSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    await host.createOrAttach({
      sessionId: 'agent-1',
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    // Regression (codex review): a killRoot that force-kills only after the
    // grace-window escalation resolves would leave the agent root alive for
    // the whole ~DESCENDANT_KILL_GRACE_MS + DESCENDANT_SNAPSHOT_TIMEOUT_MS
    // window during a daemon quit. killRoot itself must force-kill
    // synchronously; only killWithDescendantSweep's own returned promise
    // (via awaitEscalation) may lag behind that.
    let releaseSweep: () => void = () => {}
    killWithDescendantSweepMock.mockImplementationOnce(
      (_pid, killRoot) =>
        new Promise<void>((resolve) => {
          killRoot()
          releaseSweep = resolve
        })
    )

    const pending = host.dispose()

    await Promise.resolve()
    await Promise.resolve()
    expect(subprocess.forceKill).toHaveBeenCalledOnce()

    let disposed = false
    void pending.then(() => {
      disposed = true
    })
    await Promise.resolve()
    // dispose() itself must still be pending: awaitEscalation delays the
    // daemon's own shutdown so it cannot exit before the grace-window
    // escalation this promise stands in for has a chance to run.
    expect(disposed).toBe(false)

    releaseSweep()
    await pending
    expect(disposed).toBe(true)
    // The root is force-killed exactly once — killRoot must not double up
    // with a second, redundant force-kill after the sweep settles.
    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })

  it('bounds the shutdown sweep and anchors it to the spawn-captured root', async () => {
    const subprocess = createMockAgentSubprocess()
    subprocess.spawnIdentity = { rootCreationTimeMs: 777 }
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    await host.createOrAttach({
      sessionId: 'agent-1',
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    killWithDescendantSweepMock.mockImplementationOnce(async (_pid, killRoot) => {
      killRoot()
    })
    await host.dispose()

    // The daemon race cuts escalation, never the kill: the sweep carries an
    // explicit budget, and the Windows probe checks the root's creation
    // time so a recycled PID cannot read as ours (#10680).
    expect(sweepDeps().sweepTimeoutMs).toBeTypeOf('number')
    expect(sweepDeps().expectedRootCreationTimeMs).toBe(777)
  })

  it('cleans the WSL guest tree alongside the Windows-side sweep', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const subprocess = createMockAgentSubprocess()
      subprocess.spawnIdentity = { ptyTreeId: 'sess@@abc123' }
      const host = new TerminalHost({ spawnSubprocess: () => subprocess })
      await host.createOrAttach({
        sessionId: 'agent-1',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      killWithDescendantSweepMock.mockImplementationOnce(async (_pid, killRoot) => {
        killRoot()
      })
      runWslGuestTreeKillMock.mockResolvedValue(undefined)
      await host.dispose()

      // The job/verify path cannot reach the WSL2 VM, so the guest tree is
      // named by its spawn marker and killed from inside the distro while
      // the Windows-side sweep tears down wsl.exe itself.
      expect(runWslGuestTreeKillMock).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        treeId: 'sess@@abc123'
      })
      expect(killWithDescendantSweepMock).toHaveBeenCalled()
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })

  it('skips the guest kill for non-WSL agent sessions', async () => {
    const subprocess = createMockAgentSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    await host.createOrAttach({
      sessionId: 'agent-1',
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    runWslGuestTreeKillMock.mockClear()
    killWithDescendantSweepMock.mockImplementationOnce(async (_pid, killRoot) => {
      killRoot()
    })
    await host.dispose()

    expect(runWslGuestTreeKillMock).not.toHaveBeenCalled()
  })
})
