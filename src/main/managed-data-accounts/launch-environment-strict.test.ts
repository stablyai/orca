import { describe, expect, it, vi } from 'vitest'
import {
  applyManagedDataAccountEnvironment,
  managedAccountLaunchEnvironment
} from './launch-environment'

const managed = vi.hoisted(() => ({
  restoreOriginalEnvironment: vi.fn(),
  captureOriginalEnvironment: vi.fn(),
  launchEnvironment: vi.fn(() => ({ XDG_DATA_HOME: '/accounts/B' })),
  environmentForAccount: vi.fn((_provider: string, accountId: string) => {
    if (accountId === 'gone') {
      throw new Error('missing')
    }
    return { XDG_DATA_HOME: `/accounts/${accountId}` }
  })
}))

vi.mock('./service', () => ({
  getManagedDataAccountService: () => managed
}))

describe('strict managed account restart', () => {
  it('does not fall back to the active profile when a strict resume owner is missing', () => {
    const service = {
      environmentForAccount: vi.fn(() => {
        throw new Error('missing')
      }),
      launchEnvironment: vi.fn(() => ({ XDG_DATA_HOME: '/active' }))
    }
    expect(managedAccountLaunchEnvironment(service, 'opencode', 'gone', { strict: true })).toEqual(
      {}
    )
    expect(service.launchEnvironment).not.toHaveBeenCalled()
    expect(managedAccountLaunchEnvironment(service, 'opencode', 'gone')).toEqual({
      XDG_DATA_HOME: '/active'
    })
  })

  it('keeps a recorded OpenCode home when strict restart cannot use the active profile', () => {
    const recorded = { XDG_DATA_HOME: '/accounts/owner-a', ORCA_DATA_ACCOUNT_ID: 'owner-a' }
    applyManagedDataAccountEnvironment(recorded, { launchAgent: 'opencode', strict: true })
    expect(managed.environmentForAccount).toHaveBeenCalledWith('opencode', 'owner-a')
    expect(managed.launchEnvironment).not.toHaveBeenCalled()
    expect(recorded.XDG_DATA_HOME).toBe('/accounts/owner-a')
    expect(recorded.ORCA_DATA_ACCOUNT_ID).toBeUndefined()

    const missing = { XDG_DATA_HOME: '/accounts/A', ORCA_DATA_ACCOUNT_ID: 'gone' }
    applyManagedDataAccountEnvironment(missing, { launchAgent: 'opencode', strict: true })
    expect(managed.launchEnvironment).not.toHaveBeenCalled()
    expect(missing.XDG_DATA_HOME).toBe('/accounts/A')
    expect(missing.ORCA_DATA_ACCOUNT_ID).toBe('gone')
  })
})
