import { describe, expect, it, vi, type Mock } from 'vitest'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

// Why mocked: the plain-shell teardown sweeps for real, and an unmocked run would put a live
// process-table probe behind these tests.
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

/** Shells that exit only when the test says so, standing in for one inside its kill grace. */
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

    // The relaunched app lists here: the closed pane must read as closing, not restorable.
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

    expect(() => host.kill(sessionId)).toThrow('EPERM')

    expect(host.listSessions()).toMatchObject([{ sessionId, state: 'running', isAlive: true }])
    handles[0]!._simulateExit(0)
    await host.dispose()
  })
})
