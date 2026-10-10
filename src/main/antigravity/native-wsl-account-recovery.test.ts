import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness } from './native-account-test-fixtures'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), backend: vi.fn(), store: vi.fn() }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/test/user-data' })
}))
vi.mock('./native-wsl-account-target', () => ({ resolveAntigravityWslTarget: mocks.resolve }))
vi.mock('./native-wsl-credential-backend', () => ({
  createAntigravityWslCredentialBackend: mocks.backend
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: mocks.store }))
const authority = {
  distro: 'Ubuntu',
  uid: 1000,
  home: '/home/u',
  canonicalHome: '/home/u',
  authorityId: 'a'.repeat(64),
  credentialPath: '/home/u/token'
}
const target = { runtime: 'wsl', expectedAuthorityId: authority.authorityId } as const
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.resolve.mockResolvedValue(authority)
})
afterEach(() => vi.useRealTimers())
it('keeps an uncertain operation blocked until a complete native and vault refresh succeeds', async () => {
  const h = harness()
  mocks.backend.mockReturnValue(h.backend)
  mocks.store.mockReturnValue(h.store)
  const { runAntigravityAccountOperation: run } = await import('./native-account-host')
  const id = (await run(target, 'AddCurrent')).accounts[0].id
  h.setNative(null)
  vi.mocked(h.backend.write).mockRejectedValueOnce(new Error('unknown result'))
  await expect(run(target, 'Select', id)).rejects.toThrow('unknown result')
  vi.mocked(h.backend.read).mockRejectedValueOnce(new Error('guest still holds lock'))
  await expect(run(target, 'List')).rejects.toThrow('guest still holds lock')
  await expect(run(target, 'Select', id)).rejects.toThrow('Refresh Accounts')
  expect(h.backend.write).toHaveBeenCalledTimes(1)
  await run(target, 'List')
  await run(target, 'Select', id)
  expect(h.getVault().selectedAccountId).toBe(id)
})
it('does not publish selected state after a timed out backend eventually returns', async () => {
  const h = harness()
  mocks.backend.mockReturnValue(h.backend)
  mocks.store.mockReturnValue(h.store)
  const { runAntigravityAccountOperation: run } = await import('./native-account-host')
  const id = (await run(target, 'AddCurrent')).accounts[0].id
  h.setNative(null)
  let release: (() => void) | undefined
  vi.mocked(h.backend.write).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  vi.useFakeTimers()
  const pending = run(target, 'Select', id)
  const expired = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(1)
  expect(release).toBeTypeOf('function')
  await vi.advanceTimersByTimeAsync(15_000)
  await expired
  release?.()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.getVault().selectedAccountId).toBeNull()
  await expect(run(target, 'Select', id)).rejects.toThrow('Refresh Accounts')
})
