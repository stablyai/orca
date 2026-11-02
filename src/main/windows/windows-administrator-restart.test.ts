import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  existsSync: vi.fn(() => true),
  runProcess: vi.fn(),
  getWindowsAdministratorStatus: vi.fn(),
  restartDaemon: vi.fn()
}))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./windows-administrator-status', () => ({
  getWindowsAdministratorStatus: mocks.getWindowsAdministratorStatus
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: mocks.restartDaemon }))
vi.mock('../cli/bundled-cli-launcher-path', () => ({
  getBundledLauncherPath: () => 'C:\\Orca\\resources\\bin\\orca.exe'
}))

import {
  requestWindowsAdministratorRestart,
  restartLocalTerminalsAfterElevation
} from './windows-administrator-restart'

const restartFlag = '--orca-restart-local-terminals-as-administrator'
const originalArgv = process.argv

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  process.argv = [process.execPath, '--remote-debugging-port=9333', 'C:\\repo with spaces\\']
  mocks.app.isPackaged = true
  mocks.existsSync.mockReturnValue(true)
  mocks.runProcess.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  mocks.getWindowsAdministratorStatus.mockReset().mockResolvedValue(true)
  mocks.restartDaemon.mockReset().mockResolvedValue({ killedCount: 1 })
})
afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

describe('Windows administrator restart request', () => {
  it('hands the launcher its owner window and an elevated relaunch that waits for this process', async () => {
    process.argv.push(restartFlag)
    const owner = Buffer.alloc(8)
    owner.writeBigUInt64LE(0x1234n)
    await expect(requestWindowsAdministratorRestart(owner)).resolves.toBe('approved')

    const spec = mocks.runProcess.mock.calls[0][0]
    expect(spec.program).toBe('C:\\Orca\\resources\\bin\\orca-administrator-restart.exe')
    expect(spec.timeoutMs).toBeNull()
    expect(spec.args.slice(0, 2)).toEqual(['--orca-restart-as-administrator', '4660'])
    const relaunchParameters = `"--remote-debugging-port=9333" "C:\\repo with spaces\\\\" "${restartFlag}"`
    expect(spec.args[2]).toBe(
      ['--orca-relaunch-after-exit', String(process.pid), process.execPath, relaunchParameters]
        .map(quoteWindowsArgument)
        .join(' ')
    )
  })

  it('reports cancellation without throwing so the desktop stays open', async () => {
    mocks.runProcess.mockResolvedValue({ code: 2, stdout: '', stderr: '' })
    await expect(requestWindowsAdministratorRestart(null)).resolves.toBe('cancelled')
    expect(mocks.runProcess.mock.calls[0][0].args[1]).toBe('0')
  })

  it('surfaces launcher failures', async () => {
    mocks.runProcess.mockResolvedValue({ code: 1, stdout: '', stderr: 'Windows refused (5)\n' })
    await expect(requestWindowsAdministratorRestart(null)).rejects.toThrow('Windows refused (5)')
  })

  it.each(['darwin', 'linux'] as const)('refuses restart outside Windows: %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await expect(requestWindowsAdministratorRestart(null)).rejects.toThrow('installed Windows app')
  })

  it('refuses development builds and a missing launcher before asking Windows', async () => {
    mocks.app.isPackaged = false
    await expect(requestWindowsAdministratorRestart(null)).rejects.toThrow('installed Windows app')
    mocks.app.isPackaged = true
    mocks.existsSync.mockReturnValue(false)
    await expect(requestWindowsAdministratorRestart(null)).rejects.toThrow(
      'launcher is unavailable'
    )
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('replaces the local host only after verified elevation and consumes the request once', async () => {
    process.argv.push(restartFlag)
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(mocks.restartDaemon).toHaveBeenCalledOnce()
    expect(process.argv).not.toContain(restartFlag)
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(mocks.restartDaemon).toHaveBeenCalledOnce()
  })
  it.each([false, null])('preserves sessions if elevation is not proven: %s', async (status) => {
    mocks.getWindowsAdministratorStatus.mockResolvedValue(status)
    process.argv.push(restartFlag)
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(mocks.restartDaemon).not.toHaveBeenCalled()
    expect(process.argv).not.toContain(restartFlag)
  })
  it('preserves sessions for ordinary launches and canceled startup', async () => {
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    process.argv.push(restartFlag)
    const controller = new AbortController()
    controller.abort()
    await restartLocalTerminalsAfterElevation(controller.signal)
    expect(mocks.getWindowsAdministratorStatus).not.toHaveBeenCalled()
    expect(mocks.restartDaemon).not.toHaveBeenCalled()
  })
})
