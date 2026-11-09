import type * as PtySpawnValidationTypes from '../../../providers/working-directory-validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../../../providers/local-pty/local-pty-executable-spawn'
import type * as PosixPtyProcessTable from '../../../pty/process-retirement/posix-pty-process-table'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock,
  readProcessTableMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readProcessTableMock: vi.fn<(rootPid: number) => Promise<string>>(),
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

// Fixture pids must never be looked up in, or signalled through, the real host process table.
vi.mock('../../../pty/process-retirement/posix-pty-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof PosixPtyProcessTable>()),
  readPosixPtyProcessTable: readProcessTableMock
}))

vi.mock('../../../pty/shell-startup/pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Keep PowerShell resolution deterministic on non-Windows hosts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../../../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../../../providers/local-pty/local-pty-executable-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    getNodePtySpawnHelperCandidates: () => [import.meta.filename],
    resolveUnixShellPath: resolveUnixShellPathMock
  }
})

vi.mock('../../../providers/working-directory-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof PtySpawnValidationTypes>()
  return {
    ...actual,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../../../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

vi.mock('../../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from '../pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'
import { __setConptyJobNativeForTests } from '../../../windows/windows-pty-job'
import * as ptyJob from '../../../windows/windows-pty-job'

describe('createPtySubprocess', () => {
  beforeEach(() => {
    readProcessTableMock.mockReset()
    readProcessTableMock.mockResolvedValue('')
  })

  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
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
      // ConPTY force-kill settles synchronously; POSIX awaits the process table.
      const forceKill = async (): Promise<void> => handle.forceKill()
      await expect(forceKill()).rejects.toThrow('SIGKILL rejected')
      await expect(forceKill()).resolves.toBeUndefined()
      expect(killSpy).toHaveBeenCalledTimes(2)
      expect(proc.kill).toHaveBeenCalledOnce()
    } finally {
      killSpy.mockRestore()
    }
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

  // UnixTerminal.destroy() can send async SIGHUP after exit; neutralize kill before PID reuse.
  describe('proc.kill neutralization for SIGHUP-to-recycled-pid hazard', () => {
    const restorePlatform = (desc?: PropertyDescriptor) => {
      if (desc) {
        Object.defineProperty(process, 'platform', desc)
      }
    }

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
      // Job escalation avoids double-closing ConPTY’s native shell handle.
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
      const terminateJob = vi.spyOn(ptyJob, 'terminatePtyJob').mockReturnValue('unavailable')
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.forceKill()
        handle.dispose()
        // An unverified PID can be reused; the per-PTY job/native handle owns this process tree.
        expect(killSpy).not.toHaveBeenCalled()
        expect(terminateJob).toHaveBeenCalledExactlyOnceWith(proc)
        expect(proc.kill).toHaveBeenCalledOnce()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        terminateJob.mockRestore()
        killSpy.mockRestore()
        restorePlatform(origPlatform)
      }
    })
  })

  // Direct process.kill calls also need dead guards because a reaped PID can be reused.
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

    it.skipIf(process.platform === 'win32')(
      'forceKill skips the root pid when it exits while the process table is read',
      async () => {
        const proc = mockPtyProcess(55)
        spawnMock.mockReturnValue(proc)
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
        try {
          const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
          const table = Promise.withResolvers<string>()
          readProcessTableMock.mockReturnValueOnce(table.promise)
          const pending = handle.forceKill()
          proc._simulateExit(0)
          table.resolve('')
          await pending
          expect(killSpy).not.toHaveBeenCalled()
        } finally {
          killSpy.mockRestore()
        }
      }
    )

    it.skipIf(process.platform === 'win32')(
      'dispose keeps the PTY master open until an in-flight force-kill has swept',
      async () => {
        const proc = { ...mockPtyProcess(56), destroy: vi.fn() }
        spawnMock.mockReturnValue(proc)
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
        try {
          const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
          const table = Promise.withResolvers<string>()
          readProcessTableMock.mockReturnValueOnce(table.promise)
          const pending = handle.forceKill()
          handle.dispose()
          expect(proc.destroy).not.toHaveBeenCalled()
          table.resolve('')
          await pending
          expect(killSpy).toHaveBeenCalledWith(56, 'SIGKILL')
          await vi.waitFor(() => expect(proc.destroy).toHaveBeenCalledOnce())
        } finally {
          killSpy.mockRestore()
        }
      }
    )

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
  })
})
