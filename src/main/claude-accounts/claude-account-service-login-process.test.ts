import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { readActiveClaudeKeychainCredentials } from './keychain'
import { getCmdExePath } from '../../shared/windows-batch-spawn'
import {
  createService,
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-login-test')

vi.mock('electron', () => ({
  app: {
    getPath: () => CLAUDE_SERVICE_TEST_ROOT
  }
}))

const commandMocks = vi.hoisted(() => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: commandMocks.resolveClaudeCommand
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

describe('ClaudeAccountService credential capture', () => {
  beforeEach(() => {
    setPlatform('darwin')
    resetClaudeKeychainMocks()
  })

  afterEach(() => {
    restorePlatform()
  })

  it('removes command listeners when Claude sign-in times out', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['login'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        { keepStdinOpen: true }
      )
      const rejection = expect(commandPromise).rejects.toThrow(
        'Claude sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(1000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
    }
  })

  it('owns the complete cmd.exe command line for a resolved Windows Claude command', async () => {
    setPlatform('win32')
    vi.resetModules()
    commandMocks.resolveClaudeCommand.mockReturnValueOnce(
      'C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd'
    )
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => {
      child.stdout.write('{"email":"user@example.com"}\n')
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      await (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'status', '--json'],
        { windowsPath: 'C:\\tmp\\claude-auth', linuxPath: null, wslDistro: null },
        1000
      )

      expect(spawnMock).toHaveBeenCalledWith(
        process.env.ComSpec ?? 'cmd.exe',
        [
          '/d',
          '/v:off',
          '/s',
          '/c',
          '""C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json""'
        ],
        expect.objectContaining({ shell: false, windowsVerbatimArguments: true })
      )
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('keeps WSL execution separate from Windows command resolution', async () => {
    setPlatform('win32')
    vi.resetModules()
    commandMocks.resolveClaudeCommand.mockClear()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => {
      child.stdout.write('{"email":"user@example.com"}\n')
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      await (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'status', '--json'],
        {
          windowsPath: 'C:\\tmp\\claude-auth',
          linuxPath: '/home/user/.config/orca auth',
          wslDistro: 'Ubuntu Test'
        },
        1000
      )

      expect(commandMocks.resolveClaudeCommand).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        [
          '-d',
          'Ubuntu Test',
          '--exec',
          'bash',
          '-lc',
          "export CLAUDE_CONFIG_DIR='/home/user/.config/orca auth'; exec claude 'auth' 'status' '--json'"
        ],
        expect.objectContaining({ shell: false, windowsVerbatimArguments: false })
      )
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('pipes stdin only for the explicit Claude account login command', async () => {
    setPlatform('linux')
    vi.resetModules()
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    const loginChild = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    loginChild.stdin = new PassThrough()
    loginChild.stdout = new PassThrough()
    loginChild.stderr = new PassThrough()
    loginChild.kill = vi.fn()
    const statusChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    statusChild.stdout = new PassThrough()
    statusChild.stderr = new PassThrough()
    statusChild.kill = vi.fn()
    const spawnMock = vi.fn(
      (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[1] === 'login') {
          writeFileSync(
            join(options.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
            '{"claudeAiOauth":{"email":"user@example.com","accessToken":"token"}}\n',
            'utf-8'
          )
          queueMicrotask(() => loginChild.emit('close', 0))
          return loginChild
        }
        statusChild.stdout.write('{"email":"user@example.com"}\n')
        queueMicrotask(() => statusChild.emit('close', 0))
        return statusChild
      }
    )
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [] as ClaudeManagedAccount[],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
      }
      const store = {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn((updates: Partial<typeof settings>) => {
          settings = { ...settings, ...updates }
          return settings
        })
      }
      const runtimeAuth = {
        clearLastWrittenCredentialsJson: vi.fn(),
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      await service.addAccount()

      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        'claude',
        ['auth', 'login', '--claudeai'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      )
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        'claude',
        ['auth', 'status', '--json'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
      )
      expect(settings.claudeManagedAccounts[0]?.email).toBe('user@example.com')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('rejects immediately when Claude sign-in is denied', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4242
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    // Denial must tear down the whole detached login/browser tree (process-group kill on POSIX),
    // not just the direct child — otherwise the orphaned auth processes the `detached` spawn guards against leak.
    const killTree = vi.spyOn(process, 'kill').mockReturnValue(true)

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['login'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        180_000,
        { keepStdinOpen: true }
      )

      child.stderr.write('OAuth authorization failed: access_denied\n')

      await expect(commandPromise).rejects.toThrow('Claude sign-in was denied. Please try again.')
      expect(killTree).toHaveBeenCalledWith(-child.pid)
      expect(child.kill).not.toHaveBeenCalled()
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      killTree.mockRestore()
      vi.doUnmock('node:child_process')
    }
  })

  it('cancels an in-flight Claude account add', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
      }
      const store = {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn((updates: Partial<typeof settings>) => {
          settings = { ...settings, ...updates }
          return settings
        })
      }
      const runtimeAuth = {
        clearLastWrittenCredentialsJson: vi.fn(),
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1)
      })

      expect(service.cancelPendingLogin()).toBe(true)
      await expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(service.cancelPendingLogin()).toBe(false)
      expect(settings.claudeManagedAccounts).toEqual([])
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('honors cancel before Claude login command starts', async () => {
    setPlatform('linux')
    vi.resetModules()
    let releaseKeychainRead: (value: string | null) => void = () => {}
    vi.mocked(readActiveClaudeKeychainCredentials).mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseKeychainRead = resolve
      })
    )
    const spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
      }
      const store = {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn((updates: Partial<typeof settings>) => {
          settings = { ...settings, ...updates }
          return settings
        })
      }
      const runtimeAuth = {
        clearLastWrittenCredentialsJson: vi.fn(),
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(readActiveClaudeKeychainCredentials).toHaveBeenCalled()
      })

      expect(service.cancelPendingLogin()).toBe(true)
      expect(service.cancelPendingLogin()).toBe(false)
      expect(spawnMock).not.toHaveBeenCalled()
      releaseKeychainRead(null)
      await expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(spawnMock).not.toHaveBeenCalled()
      expect(service.cancelPendingLogin()).toBe(false)
      expect(settings.claudeManagedAccounts).toEqual([])
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('uses taskkill to cancel the Windows Claude login process tree', async () => {
    setPlatform('win32')
    vi.resetModules()
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.pid = 1234
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const taskkill = new EventEmitter()
    const spawnMock = vi.fn((command: string) => (command === 'taskkill.exe' ? taskkill : child))
    const cleanupInteractiveLogin = vi.fn()
    let publishTerminationPid: (pid: number) => void = () => {}
    const buildInteractiveLoginSpawn = vi.fn(() => ({
      command: getCmdExePath(),
      args: ['/d', '/c', 'start', '', '/wait', 'claude', 'auth', 'login', '--claudeai'],
      stdio: 'ignore' as const,
      windowsHide: true,
      cleanup: cleanupInteractiveLogin,
      getTerminationPid: () => null,
      waitForTerminationPid: () =>
        new Promise<number>((resolve) => {
          publishTerminationPid = resolve
        })
    }))
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
      }
      const store = {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn((updates: Partial<typeof settings>) => {
          settings = { ...settings, ...updates }
          return settings
        })
      }
      const runtimeAuth = {
        clearLastWrittenCredentialsJson: vi.fn(),
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith('claude', [
          'auth',
          'login',
          '--claudeai'
        ])
        expect(spawnMock).toHaveBeenCalledWith(
          getCmdExePath(),
          ['/d', '/c', 'start', '', '/wait', 'claude', 'auth', 'login', '--claudeai'],
          expect.objectContaining({ stdio: 'ignore', windowsHide: true })
        )
      })

      expect(service.cancelPendingLogin()).toBe(true)
      const rejection = expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(child.kill).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalledWith(
        'taskkill.exe',
        expect.anything(),
        expect.anything()
      )
      publishTerminationPid(9876)
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledWith(
          'taskkill.exe',
          ['/pid', '9876', '/t', '/f'],
          expect.objectContaining({ stdio: 'ignore', windowsHide: true })
        )
      })
      expect(destroyStdin).not.toHaveBeenCalled()
      taskkill.emit('close', 0)
      await rejection
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(cleanupInteractiveLogin).toHaveBeenCalledTimes(1)
      expect(service.cancelPendingLogin()).toBe(false)
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
    }
  })
})
