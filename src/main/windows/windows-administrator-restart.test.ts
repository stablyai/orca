import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  existsSync: vi.fn(() => true),
  getWindowsAdministratorStatus: vi.fn(),
  restartDaemon: vi.fn()
}))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('../cli/bundled-cli-launcher-path', () => ({
  getBundledLauncherPath: () => 'C:\\Orca\\resources\\bin\\orca.exe'
}))
vi.mock('./windows-administrator-status', () => ({
  getWindowsAdministratorStatus: mocks.getWindowsAdministratorStatus
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: mocks.restartDaemon }))

import {
  prepareWindowsAdministratorRestart,
  restartLocalTerminalsAfterElevation
} from './windows-administrator-restart'

const restartFlag = '--orca-restart-local-terminals-as-administrator'
const originalArgv = process.argv

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  process.argv = [process.execPath, '--remote-debugging-port=9333', 'C:\\repo with spaces\\']
  mocks.app.isPackaged = true
  mocks.existsSync.mockReturnValue(true)
  mocks.getWindowsAdministratorStatus.mockReset().mockResolvedValue(true)
  mocks.restartDaemon.mockReset().mockResolvedValue({ killedCount: 1 })
})
afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

describe('Windows administrator restart', () => {
  it('preserves quoted arguments and keeps cancellation free of terminal restart requests', () => {
    process.argv.push(restartFlag)
    const plan = prepareWindowsAdministratorRestart()
    expect(plan.execPath).toBe('C:\\Orca\\resources\\bin\\orca-administrator-restart.exe')
    expect(plan.args?.slice(0, 2)).toEqual(['--orca-restart-as-administrator', process.execPath])
    expect(plan.args?.[2]).toBe(
      `"--remote-debugging-port=9333" "C:\\repo with spaces\\\\" "${restartFlag}"`
    )
    expect(plan.args?.[3]).toBe('"--remote-debugging-port=9333" "C:\\repo with spaces\\\\"')
  })

  it.each(['darwin', 'linux'] as const)('refuses restart outside Windows: %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(prepareWindowsAdministratorRestart).toThrow('installed Windows app')
  })
  it('refuses development builds and a missing launcher before quitting', () => {
    mocks.app.isPackaged = false
    expect(prepareWindowsAdministratorRestart).toThrow('installed Windows app')
    mocks.app.isPackaged = true
    mocks.existsSync.mockReturnValue(false)
    expect(prepareWindowsAdministratorRestart).toThrow('launcher is unavailable')
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
