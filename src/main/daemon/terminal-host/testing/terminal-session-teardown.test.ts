import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSessionTeardown } from '../terminal-session-teardown'
import { disposeTerminalHostSessions } from '../terminal-host-disposal'
import type { Session } from '../../sessions/session'
import type { DescendantSnapshot } from '../../../pty/process-retirement/pty-descendant-termination'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
const terminateShutdownDescendantsMock = vi.hoisted(() => vi.fn())
vi.mock('../../sessions/terminal-descendant-shutdown', () => ({
  terminateShutdownDescendants: terminateShutdownDescendantsMock
}))
vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createPlainShellSession(overrides: Partial<Session> = {}): Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only these session members.
  return {
    launchAgent: undefined,
    pid: 4242,
    isAlive: true,
    forceKillAndWaitForExit: vi.fn(async () => {}),
    beginTermination: vi.fn(() => true),
    terminateOwnedTree: vi.fn<Session['terminateOwnedTree']>(() => 'terminated'),
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

  it('releases a guarded teardown when its existing ancestry scan finds detached work', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const session = createPlainShellSession({ cancelTermination: vi.fn() })
    const teardown = new TerminalSessionTeardown(new Map([['s1', session]]))
    const snapshot: DescendantSnapshot = {
      root: { pid: 4242, startedAt: 'root' },
      rootPgid: 4242,
      descendants: [{ pid: 4243, ppid: 4242, pgid: 4243, startedAt: 'worker' }],
      capturedAtMs: 1_000
    }
    killWithDescendantSweepMock.mockImplementationOnce(
      async (
        _pid: number,
        _killRoot: () => void,
        deps: { verifySnapshot?: (value: DescendantSnapshot) => void }
      ) => deps.verifySnapshot?.(snapshot)
    )
    const guarded = teardown.killSession('s1', session, true, {
      shellPids: new Set([4242]),
      verifyIdle: () => {}
    })
    await expect(guarded).rejects.toMatchObject({ reason: 'running_work' })
    expect(session.cancelTermination).toHaveBeenCalledOnce()
    expect(session.forceKillAndWaitForExit).not.toHaveBeenCalled()
  })

  it('keeps owning the shell and its detached work when shutdown joins a guarded teardown', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const capture = Promise.withResolvers<DescendantSnapshot>()
    const session = createPlainShellSession({
      cancelTermination: vi.fn(),
      detachAllClients: vi.fn()
    })
    const sessions = new Map([['s1', session]])
    const teardown = new TerminalSessionTeardown(sessions)
    const detachedWork = {
      root: { pid: 4242, startedAt: 'root' },
      rootPgid: 4242,
      descendants: [{ pid: 4243, ppid: 4242, pgid: 4243, startedAt: 'worker' }],
      capturedAtMs: 1_000
    }
    const stopWorker = vi.fn()
    killWithDescendantSweepMock
      .mockImplementationOnce(async (_pid, _killRoot, deps) => {
        deps.verifySnapshot(await capture.promise)
      })
      .mockImplementationOnce(async (_pid, _killRoot, deps) => {
        if (deps.ownsRoot()) {
          deps.terminateDescendants(detachedWork)
          stopWorker()
        }
      })
    const guarded = teardown.killSession('s1', session, true, {
      shellPids: new Set([4242]),
      verifyIdle: () => {}
    })
    const disposing = disposeTerminalHostSessions({
      sessions,
      sessionTeardown: teardown,
      pendingCreations: new Map(),
      killedTombstones: { clear: vi.fn() }
    })
    await Promise.resolve()
    await Promise.resolve()
    capture.resolve(detachedWork)
    await Promise.all([guarded, disposing])
    expect(stopWorker).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(0)
  })
})
