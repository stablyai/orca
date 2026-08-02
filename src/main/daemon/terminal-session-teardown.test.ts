import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import type { Session } from './session'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
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
    kill: vi.fn(),
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
    // Why: a live pnpm/node child otherwise survives the ConPTY close, keeps the console
    // non-empty, and holds the worktree cwd — failing destructive removal (#10004/#10100).
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

  it('win32 immediate kill claims termination before awaiting the sweep', async () => {
    // Why: createOrAttach rejects a doomed plain shell only via isTerminating, so the claim
    // must land before the taskkill await or an attach can bind a pane to a dying session.
    setPlatform('win32')
    const session = createPlainShellSession()
    const beginTermination = session.beginTermination as unknown as ReturnType<typeof vi.fn>
    let claimedBeforeSweep = false
    killWithDescendantSweepMock.mockImplementation(async () => {
      claimedBeforeSweep = beginTermination.mock.calls.length === 1
    })
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, true)

    expect(claimedBeforeSweep).toBe(true)
  })

  it('win32 sweep ownsRoot guard requires the live session to still own the id', async () => {
    setPlatform('win32')
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
  })

  it('non-win32 immediate kill skips the tree kill (pgroup force-kill suffices)', async () => {
    setPlatform('linux')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, true)

    expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    expect(session.forceKillAndWaitForExit).toHaveBeenCalled()
  })

  it('non-immediate (graceful) kill uses the plain kill path without a sweep', async () => {
    setPlatform('win32')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))

    await teardown.killSession('s1', session, false)

    expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    expect(session.forceKillAndWaitForExit).not.toHaveBeenCalled()
    expect(session.kill).toHaveBeenCalled()
  })
})
