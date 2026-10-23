import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)
vi.mock('../../windows/windows-pty-job', () => ({ assignHostProcessToKillOnCloseJob: vi.fn() }))

import { spawnNativeDaemonPty } from './native-pty-spawn'
import type { WindowsPowerShellStartupCommandStaging } from '../../providers/windows-shell-args'

const attempts = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map((shellPath) => ({
  shellPath,
  shellArgs: [shellPath === 'cmd.exe' ? '/K' : '-NoExit'],
  effectiveCwd: 'C:\\work',
  validationCwd: 'C:\\work',
  startupCommandDeliveredInShellArgs: true
}))
const args = {
  shellPath: attempts[0]!.shellPath,
  shellArgs: attempts[0]!.shellArgs,
  spawnCwd: 'C:\\work',
  env: {},
  cols: 80,
  rows: 24,
  windowsFallbackAttempts: attempts
}

describe('Windows shell fallback over node-pty ConPTY', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    nodePty.spawn.mockReset()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('walks both fallback shells when ConPTY rejects the primary ones', async () => {
    const proc = { pid: 9876 }
    nodePty.spawn.mockImplementation((file: string) => {
      if (file !== 'cmd.exe') {
        throw new Error(`spawn ${file} EACCES`)
      }
      return proc
    })
    const result = await spawnNativeDaemonPty(args)
    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'cmd.exe'
    ])
    expect(nodePty.spawn.mock.calls[2]![2]).toMatchObject({ useConptyDll: true })
    expect(result.process).toBe(proc)
    expect(result.shellPath).toBe('cmd.exe')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('keeps a winning PowerShell staged file until the PTY exits', async () => {
    const proc = { pid: 9876 }
    const cleanup = vi.fn()
    const startupCommandStaging: WindowsPowerShellStartupCommandStaging = {
      directoryPath: 'C:\\Temp\\orca-startup',
      scriptPath: 'C:\\Temp\\orca-startup\\startup.ps1',
      cleanup
    }
    const attemptsWithStaging = attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.shellPath === 'cmd.exe' ? {} : { startupCommandStaging })
    }))
    nodePty.spawn.mockImplementation((file: string) => {
      if (file === 'pwsh.exe') {
        throw new Error('spawn pwsh.exe EACCES')
      }
      return proc
    })

    const result = await spawnNativeDaemonPty({
      ...args,
      env: { KEEP: '1' },
      startupCommandStaging,
      windowsFallbackAttempts: attemptsWithStaging
    })

    expect(result.startupCommandStaging).toBe(startupCommandStaging)
    expect(cleanup).not.toHaveBeenCalled()
    for (const call of nodePty.spawn.mock.calls) {
      expect(call[2]?.env).toEqual({ KEEP: '1' })
    }
  })

  it('cleans staged PowerShell files when cmd.exe wins', async () => {
    const cleanup = vi.fn()
    const startupCommandStaging: WindowsPowerShellStartupCommandStaging = {
      directoryPath: 'C:\\Temp\\orca-startup',
      scriptPath: 'C:\\Temp\\orca-startup\\startup.ps1',
      cleanup
    }
    const attemptsWithStaging = attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.shellPath === 'cmd.exe' ? {} : { startupCommandStaging })
    }))
    nodePty.spawn.mockImplementation((file: string) => {
      if (file !== 'cmd.exe') {
        throw new Error(`spawn ${file} EACCES`)
      }
      return { pid: 9876 }
    })

    await spawnNativeDaemonPty({
      ...args,
      startupCommandStaging,
      windowsFallbackAttempts: attemptsWithStaging
    })

    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('starts no fallback shell once the spawn is canceled', async () => {
    const controller = new AbortController()
    const cleanup = vi.fn()
    const startupCommandStaging: WindowsPowerShellStartupCommandStaging = {
      directoryPath: 'C:\\Temp\\orca-startup',
      scriptPath: 'C:\\Temp\\orca-startup\\startup.ps1',
      cleanup
    }
    nodePty.spawn.mockImplementation(() => {
      controller.abort(new Error('spawn canceled'))
      throw new Error('spawn pwsh.exe EACCES')
    })
    await expect(
      spawnNativeDaemonPty({ ...args, startupCommandStaging, signal: controller.signal })
    ).rejects.toThrow('spawn canceled')
    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
