import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsConptyProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsConptyProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readWindowsConptyProcessIdsMock(...args)
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number; signal?: number }) => void) | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsConptyProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })

    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  describe('write', () => {
    it('writes data to the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(provider.write(id, 'hello')).toBe(true)
      expect(mockProc.write).toHaveBeenCalledWith('hello')
    })

    it('is a no-op for unknown PTY ids', () => {
      expect(provider.write('nonexistent', 'hello')).toBe(false)
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

  describe('producer flow control', () => {
    it('pauses and resumes the node-pty process directly', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      provider.pauseProducer(id)
      expect(mockProc.pause).toHaveBeenCalledTimes(1)
      provider.resumeProducer(id)
      expect(mockProc.resume).toHaveBeenCalledTimes(1)
    })

    it('is a no-op for unknown PTY ids', () => {
      expect(() => {
        provider.pauseProducer('nonexistent')
        provider.resumeProducer('nonexistent')
      }).not.toThrow()
      expect(mockProc.pause).not.toHaveBeenCalled()
      expect(mockProc.resume).not.toHaveBeenCalled()
    })

    it('swallows node-pty throws from a torn-down PTY', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      mockProc.pause.mockImplementation(() => {
        throw new Error('read EIO')
      })
      mockProc.resume.mockImplementation(() => {
        throw new Error('read EIO')
      })
      expect(() => {
        provider.pauseProducer(id)
        provider.resumeProducer(id)
      }).not.toThrow()
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

    it('classifies startup queries before runtime and public data listeners', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const runtimeData = vi.fn()
      const dataHandler = vi.fn()
      provider.configure({ onData: runtimeData })
      provider.onData(dataHandler)
      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      const onDataCb = mockProc.onData.mock.calls[0][0]
      const query = '\x1b]10;?\x07'
      const echo = ']10;rgb:2e2e/3434/3434\\'

      onDataCb(query)
      onDataCb(echo)
      onDataCb('prompt')

      expect(mockProc.write).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
      expect(runtimeData.mock.calls.map((call) => call.slice(1))).toEqual([
        ['', expect.any(Number), query.length, true],
        ['', expect.any(Number), echo.length, true],
        ['prompt', expect.any(Number)]
      ])
      expect(dataHandler.mock.calls.map(([payload]) => payload)).toEqual([
        { id, data: '', sequenceChars: query.length, seq: query.length, transformed: true },
        {
          id,
          data: '',
          sequenceChars: echo.length,
          seq: query.length + echo.length,
          transformed: true
        },
        { id, data: 'prompt' }
      ])
    })

    it('consumes a native Windows OSC color query before renderer delivery', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const dataHandler = vi.fn()
      provider.onData(dataHandler)
      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })
      const onDataCb = mockProc.onData.mock.calls[0][0]
      const query = '\x1b]10;?\x07'

      onDataCb(query)

      expect(dataHandler).toHaveBeenCalledWith({
        id,
        data: '',
        sequenceChars: query.length,
        seq: query.length,
        transformed: true
      })
      expect(mockProc.write).not.toHaveBeenCalled()
    })

    it('keeps forwarded OSC color replies for a Windows-owned WSL PTY', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
      const onDataCb = mockProc.onData.mock.calls[0][0]
      const reply = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'

      onDataCb('\x1b]11;?\x07')
      provider.write(id, reply)

      expect(mockProc.write).toHaveBeenCalledWith(reply)
    })

    it('notifies exit listeners when PTY exits', async () => {
      const exitHandler = vi.fn()
      provider.onExit(exitHandler)
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })

      // Simulate node-pty exit event
      exitCb?.({ exitCode: 0 })

      expect(exitHandler).toHaveBeenCalledWith({
        id,
        code: 0,
        incarnationId,
        cause: { kind: 'exited', exitCode: 0 }
      })
    })

    it('reports a signalled death as a signal, not as the zero node-pty pairs with it', async () => {
      const exitHandler = vi.fn()
      provider.onExit(exitHandler)
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })

      // node-pty reports an OOM/SIGKILL as {exitCode: 0, signal: 9}; dropping
      // the signal is what made a crash read as a clean finish (STA-4536).
      exitCb?.({ exitCode: 0, signal: 9 })

      expect(exitHandler).toHaveBeenCalledWith({
        id,
        code: 0,
        incarnationId,
        cause: { kind: 'signaled', signal: 9 }
      })
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
})
