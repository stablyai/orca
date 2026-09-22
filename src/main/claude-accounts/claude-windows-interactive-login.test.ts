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

describe('Claude Windows host interactive login', () => {
  afterEach(() => {
    restorePlatform()
  })

  it('resolves a Windows auth login whose child has no piped streams', async () => {
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
      windowsHide: true
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
      await (
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
})
