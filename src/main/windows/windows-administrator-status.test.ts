import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, environment } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  environment: { isPackaged: () => false, getAppPath: () => '/orca' }
}))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../../shared/app-environment', () => ({ getAppEnvironment: () => environment }))

describe('Windows desktop administrator status', () => {
  beforeEach(() => {
    vi.resetModules()
    runProcess.mockReset()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })
  afterEach(() => vi.restoreAllMocks())

  it.each(['true', 'false'])('reads %s from the native inherited-token probe', async (answer) => {
    runProcess.mockResolvedValue({ code: 0, stdout: `${answer}\r\n` })
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    expect(await getWindowsAdministratorStatus()).toBe(answer === 'true')
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: expect.stringContaining('orca.exe'),
        args: ['--orca-administrator-status']
      })
    )
  })

  it('coalesces and caches the lifetime status check', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: 'true' })
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    await Promise.all([getWindowsAdministratorStatus(), getWindowsAdministratorStatus()])
    await getWindowsAdministratorStatus()
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it.each([
    { code: 1, stdout: 'false' },
    { code: 0, stdout: 'false', timedOut: true },
    { code: 0, stdout: 'unexpected' }
  ])('keeps failed or malformed status unknown: %j', async (result) => {
    runProcess.mockResolvedValue(result)
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    expect(await getWindowsAdministratorStatus()).toBeNull()
  })

  it('keeps spawn errors unknown', async () => {
    runProcess.mockRejectedValue(new Error('Missing native launcher'))
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    expect(await getWindowsAdministratorStatus()).toBeNull()
  })

  it('does not spawn anything on other platforms', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    expect(await getWindowsAdministratorStatus()).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
