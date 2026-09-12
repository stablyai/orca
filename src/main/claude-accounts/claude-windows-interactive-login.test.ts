import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { getCmdExePath } from '../../shared/windows-batch-spawn'
import { createService, restorePlatform, setPlatform } from './claude-account-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-claude-windows-login-test'
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: vi.fn(() => 'C:\\Tools\\claude.cmd')
}))

const POWERSHELL_HOST = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

// Why: the login path now waits for a PowerShell host to be resolved, and that
// resolution spawns real processes. Pin it so these tests keep testing the login.
vi.mock('../../shared/windows-powershell-host', () => ({
  warmWindowsPowerShellHostCache: () => Promise.resolve(POWERSHELL_HOST),
  getWindowsPowerShellHost: () => POWERSHELL_HOST,
  setWindowsPowerShellHostResolutionObserver: () => {}
}))

describe('Claude Windows host interactive login', () => {
  afterEach(() => {
    restorePlatform()
  })

  it.each([true, false])('requires proof of console startup: relayedPid=%s', async (relayedPid) => {
    setPlatform('win32')
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdout = null
    child.stderr = null
    child.kill = vi.fn()
    child.pid = 4242
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    const buildInteractiveLoginSpawn = vi.fn(() => ({
      command: getCmdExePath(),
      args: [
        '/d',
        '/c',
        'start',
        '',
        '/wait',
        'C:\\Tools\\claude.cmd',
        'auth',
        'login',
        '--claudeai'
      ],
      stdio: 'ignore' as const,
      windowsHide: true,
      hasRelayedPid: () => relayedPid
    }))
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const login = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: 'C:\\tmp\\claude-auth', linuxPath: null, wslDistro: null },
        1000
      )
      await (relayedPid
        ? expect(login).resolves.toBe('')
        : expect(login).rejects.toThrow('PowerShell could not start the Claude sign-in console'))

      expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith('C:\\Tools\\claude.cmd', [
        'auth',
        'login',
        '--claudeai'
      ])
      expect(spawnMock).toHaveBeenCalledWith(
        getCmdExePath(),
        expect.arrayContaining(['start', '', '/wait']),
        expect.objectContaining({
          stdio: 'ignore',
          windowsHide: true
        })
      )
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
    }
  })

  it('times out a denied Windows login that stays alive without piped output', async () => {
    setPlatform('win32')
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdout = null
    child.stderr = null
    child.kill = vi.fn()
    child.pid = 0
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const login = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: 'C:\\tmp\\claude-auth', linuxPath: null, wslDistro: null },
        1000
      )
      const rejection = expect(login).rejects.toThrow('Claude sign-in took too long to finish.')

      await vi.advanceTimersByTimeAsync(3_000)

      await rejection
      expect(child.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
    }
  })

  // Host resolution is up to 20s per candidate with nothing spawned yet, so a
  // cancel during it must end this wait instead of sitting out the budget and
  // then opening a sign-in console the user already dismissed.
  it('ends the sign-in when cancelled while the PowerShell host is still resolving', async () => {
    setPlatform('win32')
    vi.resetModules()
    const spawnMock = vi.fn()
    let releaseWarmUp: (host: string) => void = () => {}
    vi.doMock('../../shared/windows-powershell-host', () => ({
      warmWindowsPowerShellHostCache: () =>
        new Promise<string>((resolve) => {
          releaseWarmUp = resolve
        }),
      getWindowsPowerShellHost: () => POWERSHELL_HOST,
      setWindowsPowerShellHostResolutionObserver: () => {}
    }))
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { runClaudeCommandProcess } = await import('./claude-command-process')
      const controller = new AbortController()
      const login = runClaudeCommandProcess(
        ['auth', 'login', '--claudeai'],
        { windowsPath: 'C:\\tmp\\claude-auth', linuxPath: null, wslDistro: null },
        1000,
        { signal: controller.signal }
      )

      controller.abort()
      await expect(login).rejects.toThrow('Claude sign-in was cancelled.')
      expect(spawnMock).not.toHaveBeenCalled()

      // The warm-up is shared and cached, so it is left running rather than
      // cancelled — but its late answer must not revive the abandoned sign-in.
      releaseWarmUp(POWERSHELL_HOST)
      await Promise.resolve()
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('../../shared/windows-powershell-host')
    }
  })
})
