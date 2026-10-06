import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NativeAccountHost from './native-account-host'
import { harness } from './native-account-test-fixtures'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), host: vi.fn(), wsl: vi.fn(), store: vi.fn() }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/test/user-data' })
}))
vi.mock('./native-wsl-account-target', () => ({ resolveAntigravityWslTarget: mocks.resolve }))
vi.mock('./native-credential-backend', () => ({
  createAntigravityHostCredentialBackend: mocks.host
}))
vi.mock('./native-wsl-credential-backend', () => ({
  createAntigravityWslCredentialBackend: mocks.wsl
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: mocks.store }))
let host: typeof NativeAccountHost
const authority = {
  distro: 'Ubuntu',
  uid: 1000,
  home: '/home/u',
  canonicalHome: '/home/u',
  authorityId: 'a'.repeat(64),
  credentialPath: '/home/u/token'
}
let h: ReturnType<typeof harness>
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  h = harness()
  mocks.resolve.mockResolvedValue(authority)
  mocks.store.mockReturnValue(h.store)
  mocks.wsl.mockReturnValue(h.backend)
  mocks.host.mockReturnValue(h.backend)
  host = await import('./native-account-host')
})
describe('Antigravity runtime authority routing', () => {
  it('lists the actual default WSL authority without accessing Host credentials', async () => {
    const state = await host.runAntigravityAccountOperation(
      { runtime: 'wsl', wslDistro: null },
      'List'
    )
    expect(state.resolvedTarget).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      authorityId: authority.authorityId
    })
    expect(mocks.host).not.toHaveBeenCalled()
    expect(mocks.store.mock.calls[0]?.[0]).toContain(`/wsl/${authority.authorityId}/vault`)
  })
  it('requires a matching observed authority for every WSL mutation', async () => {
    await expect(
      host.runAntigravityAccountOperation({ runtime: 'wsl' }, 'AddCurrent')
    ).rejects.toThrow('reload Accounts')
    await expect(
      host.runAntigravityAccountOperation(
        { runtime: 'wsl', expectedAuthorityId: 'b'.repeat(64) },
        'AddCurrent'
      )
    ).rejects.toThrow('reload Accounts')
    expect(mocks.store).not.toHaveBeenCalled()
    expect(h.backend.read).not.toHaveBeenCalled()
  })
  it('reuses alias services and separates different distro authorities', async () => {
    const target = { runtime: 'wsl', expectedAuthorityId: authority.authorityId } as const
    const first = await host.runAntigravityAccountOperation(target, 'AddCurrent')
    mocks.resolve.mockResolvedValue({ ...authority, distro: 'ubuntu' })
    expect(
      (await host.runAntigravityAccountOperation({ ...target, wslDistro: 'ubuntu' }, 'List'))
        .accounts[0]?.id
    ).toBe(first.accounts[0]?.id)
    expect(mocks.wsl).toHaveBeenCalledTimes(1)
    const other = harness()
    mocks.resolve.mockResolvedValue({ ...authority, distro: 'Debian', authorityId: 'b'.repeat(64) })
    mocks.store.mockReturnValue(other.store)
    mocks.wsl.mockReturnValue(other.backend)
    expect(
      (await host.runAntigravityAccountOperation({ runtime: 'wsl', wslDistro: 'Debian' }, 'List'))
        .accounts
    ).toEqual([])
    expect(mocks.wsl).toHaveBeenCalledTimes(2)
  })
  it('leaves failed service construction retryable', async () => {
    mocks.wsl.mockImplementationOnce(() => {
      throw new Error('initial failure')
    })
    await expect(host.runAntigravityAccountOperation({ runtime: 'wsl' }, 'List')).rejects.toThrow(
      'initial failure'
    )
    expect(
      (await host.runAntigravityAccountOperation({ runtime: 'wsl' }, 'List')).resolvedTarget
        ?.authorityId
    ).toBe(authority.authorityId)
  })
  it('refuses accidental distro routing on Host', async () => {
    await expect(
      host.runAntigravityAccountOperation({ runtime: 'host', wslDistro: 'Ubuntu' }, 'List')
    ).rejects.toThrow('Invalid')
    expect(mocks.host).not.toHaveBeenCalled()
  })
  it('requires readback after a failed mutation and never replays it', async () => {
    const target = { runtime: 'wsl', expectedAuthorityId: authority.authorityId } as const
    await host.runAntigravityAccountOperation(target, 'AddCurrent')
    const id = h.getVault().accounts[0].id
    h.setNative(null)
    vi.mocked(h.backend.write).mockRejectedValueOnce(new Error('unknown commit'))
    await expect(host.runAntigravityAccountOperation(target, 'Select', id)).rejects.toThrow(
      'unknown commit'
    )
    await expect(host.runAntigravityAccountOperation(target, 'Select', id)).rejects.toThrow(
      'Refresh Accounts'
    )
    expect(h.backend.write).toHaveBeenCalledTimes(1)
    await host.runAntigravityAccountOperation(target, 'List')
    await host.runAntigravityAccountOperation(target, 'Select', id)
    expect(h.backend.write).toHaveBeenCalledTimes(2)
  })
})
