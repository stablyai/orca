import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: execFileMock
}))

import { execBridge, mapBridgeError } from './desktop-script-provider-bridge'

function mockChild(): { kill: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> } {
  return { kill: vi.fn(), once: vi.fn() }
}

afterEach(() => {
  execFileMock.mockReset()
})

describe('execBridge Windows PowerShell argv', () => {
  it('starts with RemoteSigned and never Bypass on the first spawn', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '{"ok":true}', '')
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).resolves.toEqual({ stdout: '{"ok":true}', stderr: '' })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'RemoteSigned',
        '-File',
        'C:\\Orca\\runtime.ps1',
        'C:\\tmp\\operation.json'
      ],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    )
    const firstArgs = execFileMock.mock.calls[0]?.[1] as string[]
    expect(firstArgs).toContain('RemoteSigned')
    expect(firstArgs).not.toContain('Bypass')
    expect(firstArgs).not.toContain('-EncodedCommand')
  })

  it('leaves the non-Windows python3 argv unchanged', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '{"ok":true}', '')
      return mockChild()
    })

    await execBridge('linux', '/opt/orca/runtime.py', '/tmp/operation.json')

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'python3',
      ['/opt/orca/runtime.py', '/tmp/operation.json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    )
  })

  it('retries once with Bypass when the first spawn is policy-blocked', async () => {
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const policy = args[args.indexOf('-ExecutionPolicy') + 1]
      if (policy === 'RemoteSigned') {
        const error = Object.assign(new Error('Command failed: powershell.exe'), { killed: false })
        callback(
          error,
          '',
          'File C:\\Orca\\runtime.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https://go.microsoft.com/fwlink/?LinkID=135170.'
        )
      } else {
        callback(null, '{"ok":true}', '')
      }
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).resolves.toEqual({ stdout: '{"ok":true}', stderr: '' })

    expect(execFileMock).toHaveBeenCalledTimes(2)
    const firstArgs = execFileMock.mock.calls[0]?.[1] as string[]
    const secondArgs = execFileMock.mock.calls[1]?.[1] as string[]
    expect(firstArgs).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      'C:\\Orca\\runtime.ps1',
      'C:\\tmp\\operation.json'
    ])
    expect(secondArgs).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Orca\\runtime.ps1',
      'C:\\tmp\\operation.json'
    ])
    expect(secondArgs).not.toContain('-EncodedCommand')
  })

  it('does not retry Bypass for a phrase-only execution policy failure', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const error = Object.assign(new Error('Command failed: powershell.exe'), { killed: false })
      callback(error, '', 'execution policy configuration is invalid')
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).rejects.toBeTruthy()

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const firstArgs = execFileMock.mock.calls[0]?.[1] as string[]
    expect(firstArgs).toContain('RemoteSigned')
    expect(firstArgs).not.toContain('Bypass')
  })

  it('rejects a killed 30s timeout as action_timeout and does not retry Bypass', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const error = Object.assign(new Error('Command failed: powershell.exe'), { killed: true })
      callback(
        error,
        '',
        'File C:\\Orca\\runtime.ps1 cannot be loaded because running scripts is disabled on this system.'
      )
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).rejects.toMatchObject({ code: 'action_timeout' })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const firstArgs = execFileMock.mock.calls[0]?.[1] as string[]
    expect(firstArgs).toContain('RemoteSigned')
    expect(firstArgs).not.toContain('Bypass')
  })

  it('does not retry a non-policy Windows failure', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const error = Object.assign(new Error("app 'Finder' has no on-screen window"), {
        killed: false
      })
      callback(error, '', "app 'Finder' has no on-screen window")
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).rejects.toMatchObject({ code: 'window_not_found' })

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries Bypass only once when that spawn is also policy-blocked', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const error = Object.assign(new Error('Command failed: powershell.exe'), { killed: false })
      callback(
        error,
        '',
        'running scripts is disabled on this system. For more information, see about_Execution_Policies.'
      )
      return mockChild()
    })

    await expect(
      execBridge('windows', 'C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json')
    ).rejects.toBeTruthy()

    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})

describe('mapBridgeError', () => {
  it('maps native window-not-found messages without broad false positives', () => {
    expect(mapBridgeError('No top-level AT-SPI window is available for Text Editor').code).toBe(
      'window_not_found'
    )
    expect(mapBridgeError("app 'Finder' has no on-screen window").code).toBe('window_not_found')
    expect(mapBridgeError('Failed to execute window operation').code).toBe('accessibility_error')
  })

  it('maps native element-not-found messages without broad false positives', () => {
    expect(
      mapBridgeError('stale element frame; run get-app-state again and use a fresh element index')
        .code
    ).toBe('element_not_found')
    expect(mapBridgeError('unknown element_index').code).toBe('element_not_found')
    expect(mapBridgeError('element metadata unavailable').code).toBe('accessibility_error')
  })
})
