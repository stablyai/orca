import { describe, expect, it, vi } from 'vitest'
import { executeSettingsDeviceOperation } from './mobile-web-settings-device-operations'
import { executeDiagnosticsDeviceOperation } from './mobile-web-diagnostics-device-operations'

const permission = {
  granted: true,
  status: 'granted',
  canAskAgain: true,
  authorizationReflectsUserChoice: false
}
describe('settings device authority', () => {
  it('keeps passive permission reads separate from OS permission requests', async () => {
    const authority = {
      permission: vi.fn().mockResolvedValue(permission),
      preference: vi.fn(),
      openSettings: vi.fn()
    }
    await expect(
      executeSettingsDeviceOperation('notificationPermission', {}, authority)
    ).resolves.toEqual(permission)
    expect(authority.permission).toHaveBeenCalledExactlyOnceWith(undefined)
    await executeSettingsDeviceOperation('notificationPermission', { request: true }, authority)
    expect(authority.permission).toHaveBeenLastCalledWith(true)
    expect(authority.openSettings).not.toHaveBeenCalled()
  })
  it('rejects malformed opt-in writes before touching device state', async () => {
    const authority = { permission: vi.fn(), preference: vi.fn(), openSettings: vi.fn() }
    await expect(
      executeSettingsDeviceOperation('notificationPreference', { enabled: 'yes' }, authority)
    ).rejects.toThrow()
    expect(authority.preference).not.toHaveBeenCalled()
  })
  it('rejects arbitrary endpoint probes and oversized report submissions before native dispatch', async () => {
    const authority = { snapshot: vi.fn(), probe: vi.fn(), submit: vi.fn() }
    await expect(
      executeDiagnosticsDeviceOperation(
        'diagnosticsProbe',
        { target: 'host', url: 'https://example.com' },
        authority
      )
    ).rejects.toThrow()
    await expect(
      executeDiagnosticsDeviceOperation(
        'diagnosticsSubmit',
        { report: 'x'.repeat(64 * 1024 + 1), appVersion: '1', platform: 'ios' },
        authority
      )
    ).rejects.toThrow()
    expect(authority.probe).not.toHaveBeenCalled()
    expect(authority.submit).not.toHaveBeenCalled()
  })
  it('surfaces unsuccessful diagnostics delivery instead of claiming submission', async () => {
    const authority = {
      snapshot: vi.fn(),
      probe: vi.fn(),
      submit: vi.fn().mockResolvedValue({ ok: false, error: 'request timed out' })
    }
    await expect(
      executeDiagnosticsDeviceOperation(
        'diagnosticsSubmit',
        { report: 'redacted report', appVersion: '1', platform: 'ios' },
        authority
      )
    ).resolves.toEqual({ ok: false, error: 'request timed out' })
  })
})
