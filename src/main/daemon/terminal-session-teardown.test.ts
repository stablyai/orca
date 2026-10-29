import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import type { Session } from './session'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { TuiAgent } from '../../shared/tui-agent'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
const terminateShutdownDescendantsMock = vi.hoisted(() => vi.fn())
vi.mock('./terminal-descendant-shutdown', () => ({
  terminateShutdownDescendants: terminateShutdownDescendantsMock
}))
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createPlainShellSession(overrides: Partial<Session> = {}): Session {
  return {
    launchAgent: undefined,
    pid: 4242,
    isAlive: true,
    forceKillAndWaitForExit: vi.fn(async () => {}),
    beginTermination: vi.fn(() => true),
    terminateOwnedTree: vi.fn(() => 'terminated' as const),
    scheduleForceDisposeFallback: vi.fn(),
    signalTerminationRoot: vi.fn(),
    ...overrides
  } as unknown as Session
}

describe('TerminalSessionTeardown plain-shell teardown', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  it('win32 immediate kill taskkills the descendant tree before force-kill', async () => {
    // Surviving ConPTY descendants can hold the workspace cwd and prevent removal (#10004/#10100).
    setPlatform('win32')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, true)

    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      4242,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(session.forceKillAndWaitForExit).toHaveBeenCalled()
    // The sweep owns the taskkill; the killRoot callback is a no-op so force-kill drives exit.
    const killRoot = killWithDescendantSweepMock.mock.calls[0][1] as () => void
    expect(() => killRoot()).not.toThrow()
  })

  it.each(['win32', 'linux', 'darwin'] as const)(
    '%s immediate kill claims termination before awaiting the sweep',
    async (platform) => {
      // Claim termination before awaiting taskkill so a concurrent attach cannot bind to the dying session.
      setPlatform(platform)
      const session = createPlainShellSession()
      const beginTermination = session.beginTermination as unknown as ReturnType<typeof vi.fn>
      let claimedBeforeSweep = false
      killWithDescendantSweepMock.mockImplementation(async () => {
        claimedBeforeSweep = beginTermination.mock.calls.length === 1
      })
      const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

      await teardown.killSession('s1', session, true)

      expect(claimedBeforeSweep).toBe(true)
    }
  )

  it.each(['win32', 'linux', 'darwin'] as const)(
    '%s sweep ownsRoot guard requires the live session to still own the id',
    async (platform) => {
      setPlatform(platform)
      const session = createPlainShellSession()
      const sessions = new Map([['s1', session]])
      const teardown = new TerminalSessionTeardown(sessions)

      await teardown.killSession('s1', session, true)
      const ownsRoot = (killWithDescendantSweepMock.mock.calls[0][2] as { ownsRoot: () => boolean })
        .ownsRoot
      expect(ownsRoot()).toBe(true)

      // A natural exit or reap must stop us from taskkilling a recycled PID.
      ;(session as unknown as { isAlive: boolean }).isAlive = false
      expect(ownsRoot()).toBe(false)
      sessions.delete('s1')
      ;(session as unknown as { isAlive: boolean }).isAlive = true
      expect(ownsRoot()).toBe(false)
    }
  )

  it('POSIX immediate close sweeps detached OMP tools before killing their parent', async () => {
    setPlatform('linux')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, true)

    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      session.pid,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(session.forceKillAndWaitForExit).toHaveBeenCalled()
  })

  it('waits for a late immediate escalation after graceful descendant verification settles', async () => {
    let finishDescendants = (): void => {}
    let finishRoot = (): void => {}
    const descendantVerification = new Promise<void>((resolve) => {
      finishDescendants = resolve
    })
    const rootCompletion = new Promise<void>((resolve) => {
      finishRoot = resolve
    })
    terminateShutdownDescendantsMock.mockReturnValueOnce(descendantVerification)
    const snapshot: DescendantSnapshot = {
      rootPgid: 4242,
      descendants: [],
      capturedAtMs: Date.now()
    }
    killWithDescendantSweepMock.mockImplementationOnce(
      async (
        _pid: number,
        killRoot: () => void,
        deps: {
          terminateDescendants?: (value: DescendantSnapshot) => Promise<unknown>
        }
      ) => {
        deps.terminateDescendants?.(snapshot)
        killRoot()
      }
    )
    const session = createPlainShellSession({
      launchAgent: 'claude',
      forceKillAndWaitForExit: vi.fn(() => rootCompletion)
    })
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    const graceful = teardown.killSession('s1', session, false)
    await Promise.resolve()
    const immediate = teardown.requestImmediate('s1')

    expect(immediate).not.toBe(graceful)
    let settled = false
    void immediate?.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finishDescendants()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishRoot()
    await immediate
    expect(settled).toBe(true)
  })

  it('win32 graceful close of a plain shell signals only the root, leaving `start /b` jobs', async () => {
    setPlatform('win32')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, false)

    expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    expect(session.terminateOwnedTree).not.toHaveBeenCalled()
    expect(session.signalTerminationRoot).toHaveBeenCalled()
    expect(session.scheduleForceDisposeFallback).toHaveBeenCalled()
  })

  it('graceful close captures descendants before signalling a shell without launch metadata', async () => {
    // An agent typed into the shell has no launchAgent; its detached MCP tools outlive the shell's SIGHUP (#16714).
    setPlatform('linux')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, false)

    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      4242,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(session.signalTerminationRoot).not.toHaveBeenCalled()
    const killRoot = killWithDescendantSweepMock.mock.calls[0][1] as () => void
    killRoot()
    expect(session.signalTerminationRoot).toHaveBeenCalled()
    expect(session.forceKillAndWaitForExit).not.toHaveBeenCalled()
  })
})

describe('graceful close preserves shell jobs only for plain shells', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  // Shell 10 with nohup job 30 in its own background group on the tty.
  const snapshot: DescendantSnapshot = {
    root: { pid: 10, startedAt: 'Tue Jul 14 12:00:00 2026' },
    rootPgid: 10,
    capturedAtMs: 0,
    descendants: [
      { pid: 20, ppid: 10, pgid: 20, tpgid: 20, startedAt: 'Tue Jul 14 12:00:00 2026' },
      { pid: 30, ppid: 10, pgid: 30, tpgid: 20, startedAt: 'Tue Jul 14 12:00:00 2026' }
    ]
  }

  beforeEach(() => {
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockImplementation(
      async (
        _pid: number,
        _killRoot: () => void,
        deps: { terminateDescendants: (s: DescendantSnapshot) => void }
      ) => {
        deps.terminateDescendants(snapshot)
      }
    )
    terminateShutdownDescendantsMock.mockReset()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  const cases: [string, TuiAgent | null, number[]][] = [
    ['plain shell', null, [20]],
    ['Orca-launched agent', 'codex', [20, 30]]
  ]
  it.each(cases)('%s', async (_label, launchAgent, swept) => {
    const session = createPlainShellSession({ launchAgent })
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, false)

    const passed: DescendantSnapshot = terminateShutdownDescendantsMock.mock.calls[0][0]
    expect(passed.descendants.map((row) => row.pid)).toEqual(swept)
  })
})

describe('pty job ownership reaches the daemon teardown path', () => {
  // Workspace deletion uses daemon teardown; provider-only job ownership misses detached tools holding its cwd.
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function sweepTerminateOwnedTree(): () => string {
    const deps = killWithDescendantSweepMock.mock.calls[0][2] as {
      terminateOwnedTree?: () => string
    }
    expect(deps.terminateOwnedTree, 'sweep ran without job ownership').toBeTypeOf('function')
    return deps.terminateOwnedTree!
  }

  it.each([
    ['plain shell', undefined],
    ['agent session', { agent: 'claude' } as unknown as Session['launchAgent']]
  ])("hands the sweep this session's job on %s teardown", async (_case, launchAgent) => {
    const session = createPlainShellSession({ launchAgent })
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, true)

    expect(sweepTerminateOwnedTree()()).toBe('terminated')
    expect(session.terminateOwnedTree).toHaveBeenCalled()
  })
})
