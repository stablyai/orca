// SubprocessHandle io forwarding plus kill/dispose neutralization contracts.
import { describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn((cwd: string) => {
    if (cwd.includes('definitely-missing')) {
      throw new Error(
        `Working directory "${cwd}" does not exist. It may have been deleted or is on an unmounted volume.`
      )
    }
  })
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Resolve PowerShell family names to deterministic absolute paths so these
// tests run on non-Windows CI. The real resolver (which skips the Store App
// Execution Alias stub) is exercised in windows-powershell-executable.test.ts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    getNodePtySpawnHelperCandidates: () => [import.meta.filename],
    resolveUnixShellPath: resolveUnixShellPathMock,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

// Console-membership reads run a real node-pty fork that never settles under
// fake timers; default to "shell-only" so the degraded-scan guard falls through
// to its existing retirement logic (the degraded-scan behavior itself is
// covered in pty-subprocess-foreground-degraded-scan.test.ts).
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'
import { __setConptyJobNativeForTests } from '../windows/windows-pty-job'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('returns a SubprocessHandle with correct pid', async () => {
    const proc = mockPtyProcess(42)
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24
    })

    expect(handle.pid).toBe(42)
  })

  it('forwards write calls', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.write('ls\n')

    expect(proc.write).toHaveBeenCalledWith('ls\n')
  })

  it('forwards resize calls', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(120, 40)

    expect(proc.resize).toHaveBeenCalledWith(120, 40)
  })

  it('normalizes invalid initial spawn dimensions', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    await createPtySubprocess({ sessionId: 'test', cols: 0, rows: -1 })

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 24 })
    )
  })

  it('ignores transient zero-size resize calls', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(0, 0)
    handle.write('still alive\n')

    expect(proc.resize).not.toHaveBeenCalled()
    expect(proc.write).toHaveBeenCalledWith('still alive\n')
  })

  it('forwards kill calls', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.kill()

    expect(proc.kill).toHaveBeenCalled()
  })

  it('propagates rejected graceful kills without marking the wrapper dead', async () => {
    const proc = mockPtyProcess()
    proc.kill.mockImplementationOnce(() => {
      throw new Error('native kill rejected')
    })
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    expect(() => handle.kill()).toThrow('native kill rejected')
    handle.write('still owned')
    expect(() => handle.kill()).not.toThrow()

    expect(proc.write).toHaveBeenCalledWith('still owned')
    expect(proc.kill).toHaveBeenCalledTimes(2)
  })

  it('propagates rejected force kills so the owner can retry', async () => {
    const proc = mockPtyProcess(77)
    proc.kill.mockImplementation(() => {
      throw new Error('native fallback rejected')
    })
    spawnMock.mockReturnValue(proc)
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('SIGKILL rejected')
      })
      .mockImplementationOnce(() => true)

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      expect(() => handle.forceKill()).toThrow('SIGKILL rejected')
      expect(() => handle.forceKill()).not.toThrow()
      expect(killSpy).toHaveBeenCalledTimes(2)
      expect(proc.kill).toHaveBeenCalledOnce()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('forceKill sends SIGKILL to the child pid', async () => {
    const proc = mockPtyProcess(77)
    spawnMock.mockReturnValue(proc)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.forceKill()

    expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
    killSpy.mockRestore()
  })

  it('routes onData events', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const data: string[] = []
    handle.onData((d) => data.push(d))

    proc._simulateData('hello')
    expect(data).toEqual(['hello'])
  })

  it('replays data emitted before the Session registers onData', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('early setup output\r\n')
    const data: string[] = []
    handle.onData((d) => data.push(d))

    expect(data).toEqual(['early setup output\r\n'])
  })

  it('routes onExit events', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const codes: number[] = []
    handle.onExit((code) => codes.push(code))

    proc._simulateExit(42)
    expect(codes).toEqual([42])
  })

  it('replays pre-listener data before a pre-listener exit', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('last output\r\n')
    proc._simulateExit(7)
    const data: string[] = []
    const codes: number[] = []
    handle.onData((d) => data.push(d))
    handle.onExit((code) => codes.push(code))

    expect(data).toEqual(['last output\r\n'])
    expect(codes).toEqual([7])
  })

  it('preserves pre-listener data when onExit is registered before onData', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('last output\r\n')
    proc._simulateExit(7)
    const events: string[] = []
    handle.onExit((code) => events.push(`exit:${code}`))
    handle.onData((data) => events.push(`data:${data}`))

    expect(events).toEqual(['exit:7', 'data:last output\r\n'])
  })

  it('sends signal via process.kill', async () => {
    const proc = mockPtyProcess(99)
    spawnMock.mockReturnValue(proc)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.signal('SIGINT')

    expect(killSpy).toHaveBeenCalledWith(99, 'SIGINT')
    killSpy.mockRestore()
  })

  // Why: node-pty's UnixTerminal.destroy() registers _socket.once('close', () =>
  // this.kill('SIGHUP')), and the socket 'close' event can fire concurrently
  // with onExit. If kill is not neutralized by the time close fires, SIGHUP
  // targets a reaped pid that may have been recycled. These tests pin down the
  // neutralization contract on both onExit (natural-exit path) and dispose()
  // (forced-teardown path) for POSIX, and verify Windows is exempt.
  describe('proc.kill neutralization for SIGHUP-to-recycled-pid hazard', () => {
    const restorePlatform = (desc?: PropertyDescriptor) => {
      if (desc) {
        Object.defineProperty(process, 'platform', desc)
      }
    }

    it('neutralizes proc.kill on POSIX inside proc.onExit synchronously', async () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const originalKill = proc.kill
      try {
        await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        expect(proc.kill).toBe(originalKill)
        proc._simulateExit(0)
        expect(proc.kill).not.toBe(originalKill)
        // Calling the neutralized kill is a safe no-op.
        expect(() => (proc.kill as () => void)()).not.toThrow()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('DOES NOT neutralize proc.kill on Windows (WindowsTerminal.destroy needs kill)', async () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        proc._simulateExit(0)
        expect(proc.kill).toBe(originalKill)
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() neutralizes proc.kill on POSIX before calling destroy()', async () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const originalKill = proc.kill
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).not.toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows calls destroy() without neutralizing kill', async () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows skips destroy after node-pty kill()', async () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn(() => proc.kill())
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.kill()
        handle.dispose()
        expect(proc.kill).toHaveBeenCalledOnce()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('does not issue a second Windows ConPTY kill when force follows graceful kill', async () => {
      const proc = mockPtyProcess(123456) as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn(() => proc.kill())
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('already gone')
      })
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.kill()
        handle.forceKill()
        handle.dispose()

        expect(proc.kill).toHaveBeenCalledOnce()
        expect(killSpy).not.toHaveBeenCalled()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        killSpy.mockRestore()
        restorePlatform(origPlatform)
      }
    })

    it('forceKill after a Windows kill() escalates to the job instead of giving up', async () => {
      // Why: skipping the second native kill is right (it double-closes ConPTY),
      // but it made forceKill a permanent no-op, so a wedged ConPTY -- which
      // never fires onExit -- could not be escalated at all (#9854). The job
      // terminates the tree without touching the handle node-pty owns.
      const terminateJob = vi.fn().mockReturnValue(true)
      __setConptyJobNativeForTests(() => ({
        terminateJob,
        listJobProcessIds: vi.fn(),
        assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
      }))
      const proc = mockPtyProcess(123456) as ReturnType<typeof mockPtyProcess> & { _pty: number }
      proc._pty = 11
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.kill()
        handle.forceKill()

        expect(terminateJob).toHaveBeenCalledWith(11, 123456)
        // Still exactly one native kill: the escalation must not double-close.
        expect(proc.kill).toHaveBeenCalledOnce()
      } finally {
        __setConptyJobNativeForTests()
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows skips destroy after forceKill falls back to node-pty kill()', async () => {
      const proc = mockPtyProcess(123456) as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn(() => proc.kill())
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('already gone')
      })
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.forceKill()
        handle.dispose()
        expect(killSpy).toHaveBeenCalledWith(123456, 'SIGKILL')
        expect(proc.kill).toHaveBeenCalledOnce()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        killSpy.mockRestore()
        restorePlatform(origPlatform)
      }
    })

    it('dispose() is idempotent — second call does not re-invoke destroy', async () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      handle.dispose()
      handle.dispose()
      expect(proc.destroy).toHaveBeenCalledOnce()
    })
  })

  // Why: after proc.onExit fires (dead=true), proc.pid refers to a reaped child
  // whose pid may have been recycled to an unrelated process. forceKill and
  // signal call process.kill(proc.pid, ...) directly, bypassing the
  // proc.kill-neutralization applied to the node-pty instance. Without an
  // internal dead-guard, they can deliver SIGKILL/SIGINT/etc to a stranger.
  describe('forceKill/signal guard against recycled pid after exit', () => {
    it('forceKill is a no-op once proc.onExit has fired', async () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.forceKill()
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('signal is a no-op once proc.onExit has fired', async () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.signal('SIGINT')
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('forceKill before exit still fires SIGKILL (live child)', async () => {
      const proc = mockPtyProcess(77)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      handle.forceKill()
      expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
      killSpy.mockRestore()
    })
  })
})
