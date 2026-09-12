// Disposal alone does not release xterm buffers while the host still owns the Session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'
import { HeadlessEmulator } from './headless-emulator'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createMockSubprocess(): SubprocessHandle & {
  _onExitCb: ((code: number) => void) | null
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    get _onDataCb() {
      return onDataCb
    },
    get _onExitCb() {
      return onExitCb
    }
  } as SubprocessHandle & { _onExitCb: ((code: number) => void) | null }
}

describe('TerminalHost dead-session reaping (leak regression)', () => {
  let host: TerminalHost
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let emulatorDispose: ReturnType<typeof vi.spyOn>
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    // Pin POSIX so immediate force-kill teardown is deterministic across host OSes; the
    // Windows taskkill tree-kill path is covered in terminal-session-teardown.test.ts.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    killWithDescendantSweepMock.mockReset()
    emulatorDispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    const spawnFn = vi.fn(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn })
  })

  afterEach(async () => {
    await host.dispose()
    emulatorDispose.mockRestore()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function streamClient() {
    return { onData: vi.fn(), onExit: vi.fn() }
  }

  it('disposes the emulator and reaps the session when its subprocess exits', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    // Alive: emulator is held, not disposed.
    expect(emulatorDispose).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)

    // Natural exit.
    lastSubprocess._onExitCb?.(0)

    // Live surfaces disappear even though the host still owes the exit evidence.
    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('does not retain dead-session emulators across many create/exit cycles', async () => {
    const CYCLES = 5
    const expectedRecords: [string, { incarnationId: string; code: number }][] = []
    for (let i = 0; i < CYCLES; i++) {
      const created = await host.createOrAttach({
        sessionId: `session-${i}`,
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })
      lastSubprocess._onExitCb?.(0)
      expectedRecords.push([`session-${i}`, { incarnationId: created.incarnationId, code: 0 }])
    }

    const records = (host as unknown as { sessions: Map<string, unknown> }).sessions
    expect([...records]).toEqual(expectedRecords)
    expect(
      [...records.values()].every((record) => Object.getPrototypeOf(record) === Object.prototype)
    ).toBe(true)
    // Owning only scalar evidence prevents any emulator/subprocess graph from being retained.
    expect(emulatorDispose).toHaveBeenCalledTimes(CYCLES)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('reaps a session killed immediately (forceKill path)', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    lastSubprocess.forceKill = vi.fn()

    const killed = host.kill('session-1', { immediate: true })

    // Immediate teardown skips the graceful kill and force-kills the child directly. On POSIX
    // that reaches the child pgroup, so no Windows taskkill /T /F descendant sweep is needed.
    expect(lastSubprocess.kill).not.toHaveBeenCalled()
    expect(lastSubprocess.forceKill).toHaveBeenCalled()
    expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    expect(emulatorDispose).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)
    lastSubprocess._onExitCb?.(137)
    await killed

    // Emulator freed and the session gone from every live surface.
    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('retains a graceful-timeout session until the forced child physically exits', async () => {
    vi.useFakeTimers()
    try {
      let stubbornSubprocess: ReturnType<typeof createMockSubprocess> | undefined
      const stubbornHost = new TerminalHost({
        spawnSubprocess: () => {
          const sub = createMockSubprocess()
          // Stubborn child: ignores graceful kill, so the KILL_TIMEOUT_MS timer
          // must force-dispose it.
          sub.kill = vi.fn()
          sub.forceKill = vi.fn()
          stubbornSubprocess = sub
          return sub
        }
      })
      await stubbornHost.createOrAttach({
        sessionId: 'stubborn',
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })

      // Graceful kill — the no-op subprocess.kill never fires onExit.
      stubbornHost.kill('stubborn')
      expect(emulatorDispose).not.toHaveBeenCalled()

      // The 5s fallback sends SIGKILL but cannot claim physical cleanup yet.
      vi.advanceTimersByTime(5000)

      expect(emulatorDispose).not.toHaveBeenCalled()
      expect(stubbornHost.listSessions()).toHaveLength(1)

      stubbornSubprocess?._onExitCb?.(137)
      expect(emulatorDispose).toHaveBeenCalledTimes(1)
      expect(stubbornHost.listSessions()).toHaveLength(0)
      await stubbornHost.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
