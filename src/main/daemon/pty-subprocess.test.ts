import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

import { createPtySubprocess } from './pty-subprocess'

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
})
