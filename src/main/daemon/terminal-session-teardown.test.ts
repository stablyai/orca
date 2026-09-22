import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import type { Session } from './session'
import { SessionDescendantReapError } from './daemon-errors'

const reapDescendantTreeMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-tree-reap', () => ({
  reapDescendantTree: reapDescendantTreeMock
}))

type FakeSession = {
  launchAgent: Session['launchAgent']
  pid: number
  isAlive: boolean
  failedToReap: 'live' | 'unverifiable' | null
  forceKillAndWaitForExit: ReturnType<typeof vi.fn>
  beginTermination: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  terminateOwnedTree: ReturnType<typeof vi.fn>
  scheduleForceDisposeFallback: ReturnType<typeof vi.fn>
  signalTerminationRoot: ReturnType<typeof vi.fn>
}

function createPlainShellSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    launchAgent: undefined,
    pid: 4242,
    isAlive: true,
    failedToReap: null,
    forceKillAndWaitForExit: vi.fn(async () => {}),
    beginTermination: vi.fn(() => true),
    kill: vi.fn(),
    terminateOwnedTree: vi.fn(() => 'terminated' as const),
    scheduleForceDisposeFallback: vi.fn(),
    signalTerminationRoot: vi.fn(),
    ...overrides
  }
}

function asSession(session: FakeSession): Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSession is a teardown stub with only the methods TerminalSessionTeardown reads.
  return session as unknown as Session
}

describe('TerminalSessionTeardown plain-shell teardown', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    reapDescendantTreeMock.mockReset()
    reapDescendantTreeMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
      killRoot()
      return 'exited'
    })
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  it('win32 immediate kill reaps the descendant tree before force-kill completes', async () => {
    setPlatform('win32')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await teardown.killSession('s1', asSession(session), true)

    expect(reapDescendantTreeMock).toHaveBeenCalledWith(
      4242,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(session.forceKillAndWaitForExit).toHaveBeenCalled()
  })

  it.each(['win32', 'linux', 'darwin'] as const)(
    '%s immediate kill claims termination before awaiting the reap',
    async (platform) => {
      setPlatform(platform)
      const session = createPlainShellSession()
      let claimedBeforeReap = false
      reapDescendantTreeMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
        claimedBeforeReap = session.beginTermination.mock.calls.length === 1
        killRoot()
        return 'exited'
      })
      const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

      await teardown.killSession('s1', asSession(session), true)

      expect(claimedBeforeReap).toBe(true)
    }
  )

  it.each(['win32', 'linux', 'darwin'] as const)(
    '%s reap ownsRoot guard requires the live session to still own the id',
    async (platform) => {
      setPlatform(platform)
      const session = createPlainShellSession()
      const sessions = new Map([['s1', asSession(session)]])
      const teardown = new TerminalSessionTeardown(sessions)

      await teardown.killSession('s1', asSession(session), true)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vitest mock.calls is unknown[]; the third arg is the deps object we passed.
      const ownsRoot = (reapDescendantTreeMock.mock.calls[0][2] as { ownsRoot: () => boolean })
        .ownsRoot
      expect(ownsRoot()).toBe(true)

      session.isAlive = false
      expect(ownsRoot()).toBe(false)
      sessions.delete('s1')
      session.isAlive = true
      expect(ownsRoot()).toBe(false)
    }
  )

  it('POSIX immediate close reaps detached OMP tools before killing their parent', async () => {
    setPlatform('linux')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await teardown.killSession('s1', asSession(session), true)

    expect(reapDescendantTreeMock).toHaveBeenCalledWith(
      session.pid,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(session.forceKillAndWaitForExit).toHaveBeenCalled()
  })

  it('non-immediate (graceful) kill uses the plain kill path without a reap', async () => {
    setPlatform('win32')
    const session = createPlainShellSession()
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await teardown.killSession('s1', asSession(session), false)

    expect(reapDescendantTreeMock).not.toHaveBeenCalled()
    expect(session.forceKillAndWaitForExit).not.toHaveBeenCalled()
    expect(session.kill).toHaveBeenCalled()
  })

  it('marks failed-to-reap and throws when the descendant tree stays live', async () => {
    setPlatform('linux')
    const session = createPlainShellSession()
    reapDescendantTreeMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
      killRoot()
      return 'live'
    })
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await expect(teardown.killSession('s1', asSession(session), true)).rejects.toBeInstanceOf(
      SessionDescendantReapError
    )
    expect(session.failedToReap).toBe('live')
  })

  it('marks failed-to-reap and throws when the descendant tree is unverifiable', async () => {
    setPlatform('linux')
    const session = createPlainShellSession()
    reapDescendantTreeMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
      killRoot()
      return 'unverifiable'
    })
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await expect(teardown.killSession('s1', asSession(session), true)).rejects.toThrow(
      /descendant tree unverifiable/
    )
    expect(session.failedToReap).toBe('unverifiable')
  })
})

describe('pty job ownership reaches the daemon teardown path', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    reapDescendantTreeMock.mockReset()
    reapDescendantTreeMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
      killRoot()
      return 'exited'
    })
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function reapTerminateOwnedTree(): () => string {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vitest mock.calls is unknown[]; the third arg is the deps object we passed.
    const deps = reapDescendantTreeMock.mock.calls[0][2] as {
      terminateOwnedTree?: () => string
    }
    expect(deps.terminateOwnedTree, 'reap ran without job ownership').toBeTypeOf('function')
    return deps.terminateOwnedTree!
  }

  it.each([
    ['plain shell', undefined],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal launchAgent stub for the agent teardown branch.
    ['agent session', { agent: 'claude' } as Session['launchAgent']]
  ])("hands the reap this session's job on %s teardown", async (_case, launchAgent) => {
    const session = createPlainShellSession({ launchAgent })
    const teardown = new TerminalSessionTeardown(new Map([['s1', asSession(session)]]))

    await teardown.killSession('s1', asSession(session), true)

    expect(reapTerminateOwnedTree()()).toBe('terminated')
    expect(session.terminateOwnedTree).toHaveBeenCalled()
  })
})
