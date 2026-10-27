import { describe, expect, it, vi } from 'vitest'
import {
  getAntigravityAccountService,
  setAntigravityNativeCredentialChangeListener
} from './native-account-host'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { credential, harness } from './native-account-test-fixtures'

vi.mock('./native-credential-backend', () => ({ createAntigravityHostCredentialBackend: vi.fn() }))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))

describe('Antigravity runtime authority guard', () => {
  it.each(['Ubuntu', 'Debian', null])(
    'refuses a client-selected WSL distro (%s) before resolving a host backend',
    (wslDistro) => {
      expect(() => getAntigravityAccountService({ runtime: 'wsl', wslDistro })).toThrow(
        'host account was not changed'
      )
      expect(createAntigravityHostCredentialBackend).not.toHaveBeenCalled()
    }
  )

  it('rejects a distro accidentally attached to a host target', () => {
    expect(() => getAntigravityAccountService({ runtime: 'host', wslDistro: 'Ubuntu' })).toThrow(
      'not supported yet'
    )
    expect(createAntigravityHostCredentialBackend).not.toHaveBeenCalled()
  })
})

it('reports new credentials and verified account switches, but not baseline reads or sign-out', async () => {
  const h = harness()
  vi.mocked(createAntigravityHostCredentialBackend).mockReturnValue(h.backend)
  vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue(h.store)
  const changed = vi.fn()
  setAntigravityNativeCredentialChangeListener(changed)
  const service = getAntigravityAccountService({ runtime: 'host' })

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
  expect(changed).toHaveBeenCalledTimes(2)
  await service.listAccounts()
  expect(changed).toHaveBeenCalledTimes(2)
})
