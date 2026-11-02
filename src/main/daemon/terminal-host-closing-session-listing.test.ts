import { describe, expect, it, vi, type Mock } from 'vitest'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { killWithDescendantSweep } from '../pty-descendant-termination'

// Prevent fake PIDs from reaching real process-table probes.
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

/** Keep the native child alive until the test explicitly reports exit. */
function spawnManuallyExitedSubprocess(): {
  spawnSubprocess: Mock<SpawnSubprocess>
  handles: ReturnType<typeof createMockSubprocess>[]
} {
  const handles: ReturnType<typeof createMockSubprocess>[] = []
  const spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
    const handle = createMockSubprocess()
    vi.mocked(handle.kill).mockImplementation(() => {})
    vi.mocked(handle.forceKill).mockImplementation(() => {})
    handles.push(handle)
    return handle
  })
  return { spawnSubprocess, handles }
}

const streamClient = (): { onData: Mock; onExit: Mock } => ({
  onData: vi.fn(),
  onExit: vi.fn()
})

describe('TerminalHost listing of a session it is killing', () => {
  it.each([
    ['an immediate kill', true],
    ['a graceful kill', false]
  ])('lists the session as live but exiting after %s, until it exits', async (_, immediate) => {
    const { spawnSubprocess, handles } = spawnManuallyExitedSubprocess()
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@closed-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })
    expect(host.listSessions()).toMatchObject([{ sessionId, state: 'running', isAlive: true }])

    const killed = host.kill(sessionId, { immediate })

    expect(host.listSessions()).toMatchObject([{ sessionId, state: 'exiting', isAlive: true }])
    expect(host.hasLiveSessions()).toBe(true)

    handles[0]!._simulateExit(0)
    await killed
    expect(host.listSessions()).toEqual([])
    await host.dispose()
  })

  it('lists a session as running again when its kill signal is refused', async () => {
    const { spawnSubprocess, handles } = spawnManuallyExitedSubprocess()
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@unsignalled-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })
    vi.mocked(handles[0]!.kill).mockImplementation(() => {
      throw new Error('EPERM')
    })
    vi.mocked(killWithDescendantSweep).mockImplementationOnce(async (_pid, killRoot) => {
      killRoot()
    })

    await expect(host.kill(sessionId)).rejects.toThrow('EPERM')

    expect(host.listSessions()).toMatchObject([{ sessionId, state: 'running', isAlive: true }])
    handles[0]!._simulateExit(0)
    await host.dispose()
  })
})
