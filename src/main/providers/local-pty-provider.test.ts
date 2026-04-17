import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, statSyncMock, accessSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../wsl', () => ({
  parseWslPath: () => null
}))

import { LocalPtyProvider } from './local-pty-provider'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: {
    onData: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    process: string
    pid: number
  }
  let exitCb: ((info: { exitCode: number }) => void) | undefined
  let origShell: string | undefined

  beforeEach(() => {
    origShell = process.env.SHELL
    process.env.SHELL = '/bin/zsh'

    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    accessSyncMock.mockReturnValue(undefined)

    exitCb = undefined
    mockProc = {
      onData: vi.fn(),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        exitCb?.({ exitCode: -1 })
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  afterEach(() => {
    if (origShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = origShell
    }
  })

  describe('spawn', () => {
    it('returns a unique PTY id', async () => {
      const result = await provider.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeTruthy()
      expect(typeof result.id).toBe('string')
    })

    it('calls node-pty spawn with correct args', async () => {
      await provider.spawn({ cols: 120, rows: 40, cwd: '/tmp' })
      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cols: 120,
          rows: 40,
          cwd: '/tmp'
        })
      )
    })

    it('throws when cwd does not exist', async () => {
      existsSyncMock.mockImplementation((p: string) => p !== '/nonexistent')
      await expect(provider.spawn({ cols: 80, rows: 24, cwd: '/nonexistent' })).rejects.toThrow(
        'does not exist'
      )
    })

    it('invokes onSpawned callback', async () => {
      const onSpawned = vi.fn()
      provider.configure({ onSpawned })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(onSpawned).toHaveBeenCalledWith(id)
    })

    it('invokes buildSpawnEnv callback to customize environment', async () => {
      const buildSpawnEnv = vi.fn((_id: string, env: Record<string, string>) => {
        env.CUSTOM_VAR = 'custom-value'
        return env
      })
      provider.configure({ buildSpawnEnv })
      await provider.spawn({ cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.CUSTOM_VAR).toBe('custom-value')
    })

    it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      const originalUserProfile = process.env.USERPROFILE
      const originalHomeDrive = process.env.HOMEDRIVE
      const originalHomePath = process.env.HOMEPATH

      Object.defineProperty(process, 'platform', { value: 'win32' })
      delete process.env.USERPROFILE
      process.env.HOMEDRIVE = 'D:'
      process.env.HOMEPATH = '\\Users\\orca'

      try {
        await provider.spawn({ cols: 80, rows: 24 })
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

  describe('write', () => {
    it('writes data to the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      provider.write(id, 'hello')
      expect(mockProc.write).toHaveBeenCalledWith('hello')
    })

    it('is a no-op for unknown PTY ids', () => {
      provider.write('nonexistent', 'hello')
      expect(mockProc.write).not.toHaveBeenCalled()
    })
  })

  describe('resize', () => {
    it('resizes the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      provider.resize(id, 120, 40)
      expect(mockProc.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('shutdown', () => {
    it('kills the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, true)
      expect(mockProc.kill).toHaveBeenCalled()
    })

    it('invokes onExit callback via the node-pty exit handler', async () => {
      const onExit = vi.fn()
      provider.configure({ onExit })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, true)
      expect(onExit).toHaveBeenCalledWith(id, -1)
    })

    it('is a no-op for unknown PTY ids', async () => {
      await provider.shutdown('nonexistent', true)
      expect(mockProc.kill).not.toHaveBeenCalled()
    })
  })

  describe('hasChildProcesses', () => {
    it('returns false when foreground process matches shell', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(false)
    })

    it('returns true when foreground process differs from shell', async () => {
      mockProc.process = 'node'
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(true)
    })

    it('returns false for unknown PTY ids', async () => {
      expect(await provider.hasChildProcesses('nonexistent')).toBe(false)
    })
  })

  describe('getForegroundProcess', () => {
    it('returns the process name', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.getForegroundProcess(id)).toBe('zsh')
    })

    it('returns null for unknown PTY ids', async () => {
      expect(await provider.getForegroundProcess('nonexistent')).toBeNull()
    })
  })

  describe('event listeners', () => {
    it('notifies data listeners when PTY produces output', async () => {
      const dataHandler = vi.fn()
      provider.onData(dataHandler)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      // Simulate node-pty data event
      const onDataCb = mockProc.onData.mock.calls[0][0]
      onDataCb('hello world')

      expect(dataHandler).toHaveBeenCalledWith({ id, data: 'hello world' })
    })

    it('notifies exit listeners when PTY exits', async () => {
      const exitHandler = vi.fn()
      provider.onExit(exitHandler)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      // Simulate node-pty exit event
      exitCb?.({ exitCode: 0 })

      expect(exitHandler).toHaveBeenCalledWith({ id, code: 0 })
    })

    it('allows unsubscribing from events', async () => {
      const dataHandler = vi.fn()
      const unsub = provider.onData(dataHandler)
      const { id: _id } = await provider.spawn({ cols: 80, rows: 24 })

      unsub()
      const onDataCb = mockProc.onData.mock.calls[0][0]
      onDataCb('hello')

      expect(dataHandler).not.toHaveBeenCalled()
    })
  })

  describe('listProcesses', () => {
    it('returns spawned PTYs', async () => {
      const before = await provider.listProcesses()
      await provider.spawn({ cols: 80, rows: 24 })
      await provider.spawn({ cols: 80, rows: 24 })
      const after = await provider.listProcesses()
      expect(after.length - before.length).toBe(2)
      const newEntries = after.slice(before.length)
      expect(newEntries[0]).toHaveProperty('id')
      expect(newEntries[0]).toHaveProperty('title', 'zsh')
    })
  })

  describe('getDefaultShell', () => {
    it('returns SHELL env var on Unix', async () => {
      const originalShell = process.env.SHELL
      try {
        process.env.SHELL = '/bin/bash'
        expect(await provider.getDefaultShell()).toBe('/bin/bash')
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
      }
    })
  })

  describe('killAll', () => {
    it('kills all PTY processes', async () => {
      await provider.spawn({ cols: 80, rows: 24 })
      await provider.spawn({ cols: 80, rows: 24 })

      provider.killAll()

      expect(mockProc.kill).toHaveBeenCalled()
      const list = await provider.listProcesses()
      expect(list).toHaveLength(0)
    })
  })
})
