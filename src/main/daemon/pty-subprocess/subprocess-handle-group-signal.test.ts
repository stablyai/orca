import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import { createDaemonPtySubprocessHandle } from './subprocess-handle'
import { mockPtyProcess } from '../pty-subprocess-test-harness'

const signalPosixPtyProcessGroups = vi.hoisted(() => vi.fn())
const readPosixProcessGroupsOnTerminal = vi.hoisted(() => vi.fn())

vi.mock('../../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn(),
  signalPosixPtyProcessGroups,
  readPosixProcessGroupsOnTerminal
}))

vi.mock('./foreground-process-tracker', () => ({
  createPtyForegroundProcessTracker: () => ({
    recordOutput: vi.fn(),
    markDead: vi.fn(),
    getForegroundProcess: () => null,
    confirmForegroundProcess: vi.fn(),
    confirmShellForeground: vi.fn()
  })
}))

function createHandle(ptsName?: string) {
  const proc = { ...mockPtyProcess(10), ...(ptsName ? { ptsName } : {}) }
  const handle = createDaemonPtySubprocessHandle({
    process: proc as unknown as pty.IPty,
    shellPath: 'bash',
    spawnCwd: '/tmp',
    env: {},
    startupCommandDeliveredInShellArgs: false,
    reportsChildExitStatus: true,
    sessionId: 'group-signal',
    startupAgentRecognition: null
  })
  return { proc, handle }
}

describe('signalProcessGroups after the root exits', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    signalPosixPtyProcessGroups.mockReset()
    readPosixProcessGroupsOnTerminal.mockReset()
    vi.restoreAllMocks()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('SIGKILLs groups captured while the root was alive', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    signalPosixPtyProcessGroups.mockImplementation(
      (
        _pid: number,
        _signal: NodeJS.Signals,
        _fallback: () => void,
        deps?: { signalProcessGroup?: (pgid: number) => void }
      ) => {
        deps?.signalProcessGroup?.(4242)
        deps?.signalProcessGroup?.(4243)
      }
    )
    readPosixProcessGroupsOnTerminal.mockReturnValue([4242, 4243])
    const { proc, handle } = createHandle('/dev/ttys001')

    handle.signalProcessGroups?.('SIGTERM')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-4243, 'SIGTERM')

    proc._simulateExit(0)
    kill.mockClear()
    signalPosixPtyProcessGroups.mockClear()

    handle.signalProcessGroups?.('SIGKILL')

    expect(signalPosixPtyProcessGroups).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(kill).toHaveBeenCalledWith(-4243, 'SIGKILL')
    expect(readPosixProcessGroupsOnTerminal).toHaveBeenCalledWith('/dev/ttys001')
  })

  it('does not SIGKILL a remembered group that left the PTY', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    signalPosixPtyProcessGroups.mockImplementation(
      (
        _pid: number,
        _signal: NodeJS.Signals,
        _fallback: () => void,
        deps?: { signalProcessGroup?: (pgid: number) => void }
      ) => {
        deps?.signalProcessGroup?.(4242)
        deps?.signalProcessGroup?.(4243)
      }
    )
    readPosixProcessGroupsOnTerminal.mockReturnValue([4242])
    const { proc, handle } = createHandle('/dev/ttys001')

    handle.signalProcessGroups?.('SIGTERM')
    proc._simulateExit(0)
    kill.mockClear()

    handle.signalProcessGroups?.('SIGKILL')

    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(kill).not.toHaveBeenCalledWith(-4243, 'SIGKILL')
  })

  it('does not SIGKILL remembered groups when the PTY table cannot be read', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    signalPosixPtyProcessGroups.mockImplementation(
      (
        _pid: number,
        _signal: NodeJS.Signals,
        _fallback: () => void,
        deps?: { signalProcessGroup?: (pgid: number) => void }
      ) => {
        deps?.signalProcessGroup?.(4242)
      }
    )
    readPosixProcessGroupsOnTerminal.mockReturnValue(null)
    const { proc, handle } = createHandle('/dev/ttys001')

    handle.signalProcessGroups?.('SIGTERM')
    proc._simulateExit(0)
    kill.mockClear()

    handle.signalProcessGroups?.('SIGKILL')

    expect(kill).not.toHaveBeenCalled()
  })

  it('does not look up a root that exited before any group was captured', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { proc, handle } = createHandle()

    proc._simulateExit(0)
    handle.signalProcessGroups?.('SIGKILL')

    expect(signalPosixPtyProcessGroups).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })
})
