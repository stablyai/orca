/* oxlint-disable max-lines -- Why: exercises full PTY subprocess surface (spawn setup, signal routing, data events, platform-specific shell configs, and Windows PowerShell implementations) with co-located test scenarios to prevent fixture drift. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { spawnMock, isPwshAvailableMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

import { createPtySubprocess } from './pty-subprocess'

const ORCA_SHELL_WRAPPER_ENV = [
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_PI_CODING_AGENT_DIR'
] as const
const POWERSHELL_PROFILE_COMMAND = expect.stringMatching(
  /ORCA_OPENCODE_CONFIG_DIR[\s\S]*ORCA_PI_CODING_AGENT_DIR[\s\S]*UTF8/
)

function mockPtyProcess(pid = 12345) {
  const onDataListeners: ((data: string) => void)[] = []
  const onExitListeners: ((e: { exitCode: number }) => void)[] = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      onExitListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    _simulateData: (data: string) => onDataListeners.forEach((cb) => cb(data)),
    _simulateExit: (code: number) => onExitListeners.forEach((cb) => cb({ exitCode: code }))
  }
}

describe('createPtySubprocess', () => {
  const savedWrapperEnv: Partial<Record<(typeof ORCA_SHELL_WRAPPER_ENV)[number], string>> = {}
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    isPwshAvailableMock.mockReturnValue(false)
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-subprocess-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      savedWrapperEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      if (savedWrapperEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedWrapperEnv[key]
      }
      delete savedWrapperEnv[key]
    }
  })
  it('spawns node-pty with correct options', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      cwd: '/home/user',
      env: { SHELL: '/bin/bash', FOO: 'bar' }
    })

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        name: 'xterm-256color'
      })
    )
  })

  it('returns a SubprocessHandle with correct pid', () => {
    const proc = mockPtyProcess(42)
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24
    })

    expect(handle.pid).toBe(42)
  })

  it('forwards write calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.write('ls\n')

    expect(proc.write).toHaveBeenCalledWith('ls\n')
  })

  it('forwards resize calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(120, 40)

    expect(proc.resize).toHaveBeenCalledWith(120, 40)
  })

  it('normalizes invalid initial spawn dimensions', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({ sessionId: 'test', cols: 0, rows: -1 })

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 24 })
    )
  })

  it('ignores transient zero-size resize calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(0, 0)
    handle.write('still alive\n')

    expect(proc.resize).not.toHaveBeenCalled()
    expect(proc.write).toHaveBeenCalledWith('still alive\n')
  })

  it('forwards kill calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.kill()

    expect(proc.kill).toHaveBeenCalled()
  })

  it('forceKill sends SIGKILL to the child pid', () => {
    const proc = mockPtyProcess(77)
    spawnMock.mockReturnValue(proc)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.forceKill()

    expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
    killSpy.mockRestore()
  })

  it('routes onData events', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const data: string[] = []
    handle.onData((d) => data.push(d))

    proc._simulateData('hello')
    expect(data).toEqual(['hello'])
  })

  it('routes onExit events', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const codes: number[] = []
    handle.onExit((code) => codes.push(code))

    proc._simulateExit(42)
    expect(codes).toEqual([42])
  })

  it('sends signal via process.kill', () => {
    const proc = mockPtyProcess(99)
    spawnMock.mockReturnValue(proc)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.signal('SIGINT')

    expect(killSpy).toHaveBeenCalledWith(99, 'SIGINT')
    killSpy.mockRestore()
  })

  it('uses SHELL env or defaults to /bin/zsh on non-Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })

    const shellArg = spawnMock.mock.calls[0][0]
    expect(typeof shellArg).toBe('string')
    expect(shellArg.length).toBeGreaterThan(0)
  })

  it('passes custom env to spawned process', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { MY_VAR: 'test-value' }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    const spawnEnv = lastCall[2].env
    expect(spawnEnv.MY_VAR).toBe('test-value')
  })

  it('uses shell wrapper when attribution shims must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: {
        SHELL: '/bin/zsh',
        ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/orca-terminal-attribution/posix'
      }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toContain('shell-ready/zsh')
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when OpenCode config must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: {
        SHELL: '/bin/zsh',
        OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay'
      }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toContain('shell-ready/zsh')
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when Pi config must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: {
        SHELL: '/bin/zsh',
        PI_CODING_AGENT_DIR: '/tmp/orca-pi-agent-overlay',
        ORCA_PI_CODING_AGENT_DIR: '/tmp/orca-pi-agent-overlay'
      }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toContain('shell-ready/zsh')
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalUserProfile = process.env.USERPROFILE
    const originalHomeDrive = process.env.HOMEDRIVE
    const originalHomePath = process.env.HOMEPATH

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.USERPROFILE
    process.env.HOMEDRIVE = 'D:'
    process.env.HOMEPATH = '\\Users\\orca'

    try {
      createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
      if (originalHomeDrive === undefined) {
        delete process.env.HOMEDRIVE
      } else {
        process.env.HOMEDRIVE = originalHomeDrive
      }
      if (originalHomePath === undefined) {
        delete process.env.HOMEPATH
      } else {
        process.env.HOMEPATH = originalHomePath
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: 'D:\\Users\\orca' })
    )
  })

  it('keeps powershell.exe when the inbox PowerShell implementation is selected on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoExit', '-Command', POWERSHELL_PROFILE_COMMAND],
      expect.any(Object)
    )
  })

  it('spawns pwsh.exe when PowerShell 7 is selected and available on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'pwsh.exe',
      ['-NoExit', '-Command', POWERSHELL_PROFILE_COMMAND],
      expect.any(Object)
    )
  })

  it('falls back to powershell.exe when PowerShell 7 is selected but unavailable on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoExit', '-Command', POWERSHELL_PROFILE_COMMAND],
      expect.any(Object)
    )
  })

  it('falls back to powershell.exe when shellOverride requests pwsh.exe but pwsh is unavailable on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'pwsh.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoExit', '-Command', POWERSHELL_PROFILE_COMMAND],
      expect.any(Object)
    )
  })

  it('ignores the PowerShell implementation setting for cmd.exe on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'cmd.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/K', 'chcp 65001 > nul'],
      expect.any(Object)
    )
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

    it('neutralizes proc.kill on POSIX inside proc.onExit synchronously', () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const originalKill = proc.kill
      try {
        createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        expect(proc.kill).toBe(originalKill)
        proc._simulateExit(0)
        expect(proc.kill).not.toBe(originalKill)
        // Calling the neutralized kill is a safe no-op.
        expect(() => (proc.kill as () => void)()).not.toThrow()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('DOES NOT neutralize proc.kill on Windows (WindowsTerminal.destroy needs kill)', () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        proc._simulateExit(0)
        expect(proc.kill).toBe(originalKill)
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() neutralizes proc.kill on POSIX before calling destroy()', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const originalKill = proc.kill
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).not.toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows calls destroy() without neutralizing kill', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() is idempotent — second call does not re-invoke destroy', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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
    it('forceKill is a no-op once proc.onExit has fired', () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.forceKill()
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('signal is a no-op once proc.onExit has fired', () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.signal('SIGINT')
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('forceKill before exit still fires SIGKILL (live child)', () => {
      const proc = mockPtyProcess(77)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      handle.forceKill()
      expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
      killSpy.mockRestore()
    })
  })
})
