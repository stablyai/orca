import type * as pty from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import type { WindowsPowerShellStartupCommandStaging } from '../shell-launch/windows/shell-args'
import { spawnShellWithFallback, type WindowsShellSpawnAttempt } from './local-pty-executable-spawn'

function staging(): WindowsPowerShellStartupCommandStaging {
  return {
    directoryPath: 'C:\\Temp\\orca-powershell-startup-test',
    scriptPath: 'C:\\Temp\\orca-powershell-startup-test\\startup.ps1',
    cleanup: vi.fn()
  }
}

function attempt(shellPath: string): WindowsShellSpawnAttempt {
  return {
    shellPath,
    shellArgs: [],
    effectiveCwd: 'C:\\work',
    validationCwd: 'C:\\work',
    startupCommandDeliveredInShellArgs: true
  }
}

describe('spawnShellWithFallback startup staging', () => {
  it('keeps the primary staged command until the PTY exits', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const startupCommandStaging = staging()
      const processHandle = {} as pty.IPty
      const result = spawnShellWithFallback({
        shellPath: 'pwsh.exe',
        shellArgs: [],
        cols: 80,
        rows: 24,
        cwd: 'C:\\work',
        env: {},
        ptySpawn: vi.fn(() => processHandle),
        startupCommandStaging,
        windowsFallbackAttempts: [attempt('pwsh.exe'), attempt('powershell.exe')]
      })

      expect(result.startupCommandStaging).toBe(startupCommandStaging)
      expect(startupCommandStaging.cleanup).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('cleans the staged command when cmd.exe wins the fallback', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const startupCommandStaging = staging()
      const processHandle = {} as pty.IPty
      const ptySpawn = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('pwsh failed')
        })
        .mockImplementationOnce(() => {
          throw new Error('powershell failed')
        })
        .mockReturnValueOnce(processHandle)

      const result = spawnShellWithFallback({
        shellPath: 'pwsh.exe',
        shellArgs: [],
        cols: 80,
        rows: 24,
        cwd: 'C:\\work',
        env: {},
        ptySpawn,
        startupCommandStaging,
        windowsFallbackAttempts: [
          attempt('pwsh.exe'),
          attempt('powershell.exe'),
          attempt('cmd.exe')
        ]
      })

      expect(result.shellPath).toBe('cmd.exe')
      expect(result.startupCommandStaging).toBeUndefined()
      expect(startupCommandStaging.cleanup).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
