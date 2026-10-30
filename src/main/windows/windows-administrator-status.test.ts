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

  it('coalesces and caches the lifetime status check', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: 'true' })
    const { getWindowsAdministratorStatus } = await import('./windows-administrator-status')
    await Promise.all([getWindowsAdministratorStatus(), getWindowsAdministratorStatus()])
    await getWindowsAdministratorStatus()
    expect(runProcess).toHaveBeenCalledTimes(1)
  })
})
