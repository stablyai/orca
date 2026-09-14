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
  readWindowsPtyJobProcessIdsMock,
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
  readWindowsPtyJobProcessIdsMock: vi.fn(),
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

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
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
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

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
      readWindowsPtyJobProcessIdsMock,
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

  describe('spawn', () => {
    it('delegates markerless Codex startup to the shell wrapper without a PTY write', async () => {
      process.env.SHELL = '/bin/zsh'
      const command = "codex '--dangerously-bypass-approvals-and-sandbox'"

      await provider.spawn({ cols: 80, rows: 24, command })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env
      expect(spawnEnv[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(command)
      expect(spawnEnv.ORCA_SHELL_FEATURES).toContain('startup')
      expect(spawnEnv.ORCA_SHELL_FEATURES).not.toContain('ready')
      expect(mockProc.write).not.toHaveBeenCalled()
    })

    it('keeps payload-bearing Codex startup in the wrapper readiness path', async () => {
      process.env.SHELL = '/bin/zsh'
      const command = "codex '--dangerously-bypass-approvals-and-sandbox' 'review this branch'"

      await provider.spawn({
        cols: 80,
        rows: 24,
        command,
        startupCommandDelivery: 'shell-ready'
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env
      expect(spawnEnv[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(command)
      expect(spawnEnv.ORCA_SHELL_FEATURES).toContain('startup')
      expect(spawnEnv.ORCA_SHELL_FEATURES).toContain('ready')
      expect(mockProc.write).not.toHaveBeenCalled()
    })

    it('scrubs an inherited wrapper startup command from ordinary panes', async () => {
      process.env.SHELL = '/bin/zsh'

      await provider.spawn({
        cols: 80,
        rows: 24,
        env: { [POSIX_SHELL_STARTUP_COMMAND_ENV]: 'poisoned command' }
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env
      expect(spawnEnv[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBeUndefined()
      expect(mockProc.write).not.toHaveBeenCalled()
    })

    it('retains PTY delivery for unsupported local shells without leaking wrapper state', async () => {
      vi.useFakeTimers()
      try {
        process.env.SHELL = '/bin/sh'
        const command = "codex '--dangerously-bypass-approvals-and-sandbox'"

        await provider.spawn({ cols: 80, rows: 24, command })

        const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env
        expect(spawnEnv[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBeUndefined()
        expect(mockProc.write).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(200)
        expect(mockProc.write).toHaveBeenCalledWith(`${command}\n`)
      } finally {
        vi.useRealTimers()
      }
    })

    it('verifies shell identity against the exact spawn PATH', async () => {
      provider.configure({
        buildSpawnEnv: (_id, env) => ({ ...env, PATH: '/post-hook/bin' })
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        command: 'printf ready',
        env: { PATH: '/pre-hook/bin' }
      })

      expect(spawnMock.mock.calls.at(-1)?.[2].env.PATH).toBe('/post-hook/bin')
      expect(createShellPromptReadinessProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ shellPathEnv: '/post-hook/bin' })
      )
    })

    // Order matters: this case reads spawnMock.mock.calls[0], which the preceding
    // default-shell spawn populates (spawnMock accumulates calls across tests).
    it('uses fallback shell readiness when startup-command shell spawn falls back', async () => {
      vi.useFakeTimers()
      try {
        process.env.SHELL = '/usr/bin/fish'
        spawnMock.mockImplementationOnce(() => {
          throw new Error('fish failed')
        })
        spawnMock.mockReturnValue(mockProc)

        await provider.spawn({ cols: 80, rows: 24, command: "printf 'linked issue context'" })

        expect(spawnMock.mock.calls[0]?.[0]).toBe('/bin/zsh')
        await Promise.resolve()
        vi.advanceTimersByTime(50)
        await Promise.resolve()
        expect(mockProc.write).not.toHaveBeenCalled()

        const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void
        dataCallback('\x1b]777;orca-shell-ready\x07user@host % ')
        await Promise.resolve()
        vi.advanceTimersByTime(29)
        await Promise.resolve()
        expect(mockProc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        expect(mockProc.write).toHaveBeenCalledWith("printf 'linked issue context'\n")
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ['after the ready marker', ['\x1b]777;orca-shell-ready\x07', '\x1b[?2004hfish> ']],
      ['after the ESC introducer', ['\x1b]777;orca-shell-ready\x07\x1b', '[?2004hfish> ']]
    ])('preserves Fish bracketed-paste output split %s', async (_boundary, chunks) => {
      process.env.SHELL = '/usr/bin/fish'
      const received: string[] = []
      provider.configure({ onData: (_id, data) => received.push(data) })

      await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })
      const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void
      for (const chunk of chunks) {
        dataCallback(chunk)
      }

      expect(received.join('')).toBe('\x1b[?2004hfish> ')
    })

    it('releases held marker-prefix bytes when local shell readiness times out', async () => {
      vi.useFakeTimers()
      const onData = vi.fn()
      provider.configure({ onData })
      try {
        await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })
        const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void

        dataCallback('\x1b]777;orca-shell-ready')
        expect(onData).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1500)
        await Promise.resolve()

        expect(onData).toHaveBeenCalledWith(
          expect.any(String),
          '\x1b]777;orca-shell-ready',
          expect.any(Number)
        )
        expect(mockProc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(200)
        await Promise.resolve()
        expect(mockProc.write).toHaveBeenCalledWith('printf ready\n')
      } finally {
        vi.useRealTimers()
      }
    })

    it('releases held marker-prefix bytes when local shell exits before readiness', async () => {
      const onData = vi.fn()
      provider.configure({ onData })

      await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })
      const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void

      dataCallback('\x1b]777;orca-shell-ready')
      expect(onData).not.toHaveBeenCalled()

      exitCb?.({ exitCode: 0 })

      expect(onData).toHaveBeenCalledWith(
        expect.any(String),
        '\x1b]777;orca-shell-ready',
        expect.any(Number)
      )
    })
  })
})
