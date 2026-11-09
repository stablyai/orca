import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  getAntigravityAccountService,
  setAntigravityNativeCredentialChangeListener
} from './native-account-host'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'
import { parseAntigravityWindowsSnapshot } from './native-windows-token-decode'
import './native-wsl-credentials'

void process.platform

vi.mock('./native-credential-backend', () => ({ createAntigravityHostCredentialBackend: vi.fn() }))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('./native-wsl-credentials', () => ({ createAntigravityWslCredentialBackend: vi.fn() }))
vi.mock('../wsl/discovery/wsl-default-distro', () => ({
  resolveWslDefaultDistro: async () => 'Ubuntu'
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))

it('reports new credentials and verified account switches, but not baseline reads or sign-out', async () => {
  const h = harness()
  const parse = vi.fn(parseAntigravityWindowsSnapshot)
  h.backend.parse = parse
  vi.mocked(createAntigravityHostCredentialBackend).mockReturnValue(h.backend)
  vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue(h.store)
  const changed = vi.fn()
  setAntigravityNativeCredentialChangeListener(changed)
  const service = await getAntigravityAccountService({ runtime: 'host' })
  expect(createEncryptedAntigravityAccountStore).toHaveBeenCalledWith(
    join('/task/home', 'antigravity-accounts', 'vault'),
    parse
  )
  expect(await getAntigravityAccountService({ runtime: 'host' })).toBe(service)
  expect(createAntigravityHostCredentialBackend).toHaveBeenCalledTimes(1)

  const a = (await service.addCurrentAccount()).activeAccountId!
  await service.listAccounts()
  expect(changed).not.toHaveBeenCalled()

  h.setNative(null)
  await service.listAccounts()
  expect(changed).not.toHaveBeenCalled()

  h.setNative(credential('b'))
  await service.addCurrentAccount()
  expect(changed).toHaveBeenCalledTimes(1)
  await service.selectAccount(a)
  expect(parse).toHaveBeenCalledWith(credential('a'))
  expect(changed).toHaveBeenCalledTimes(2)
  await service.listAccounts()
  expect(changed).toHaveBeenCalledTimes(2)

  // Signing in again to the same account issues a new grant, which must clear a sign-in hold.
  h.setNative(credential('a', 2))
  await service.listAccounts()
  expect(changed).toHaveBeenCalledTimes(3)

  h.setNative(refreshedWithoutIdToken(3, 'refresh-2'))
  await service.listAccounts()
  expect(changed).toHaveBeenCalledTimes(3)
})
