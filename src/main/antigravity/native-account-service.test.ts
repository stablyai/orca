import { describe, expect, it } from 'vitest'
import {
  AntigravityAccountService,
  createMemoryAntigravityAccountStore,
  createSyntheticAntigravityAccount,
  type AntigravityCredentialBackend
} from './native-account-service'

const first = '{"auth_method":"consumer","token":{"access_token":"first"}}'
const second = '{"auth_method":"consumer","token":{"access_token":"second"}}'

function backend(initial: string): AntigravityCredentialBackend & { current: string } {
  const result = {
    current: initial,
    read: async () => ({ contents: result.current, authMethod: 'consumer', identity: null }),
    write: async (contents: string) => {
      result.current = contents
    }
  }
  return result
}

describe('AntigravityAccountService', () => {
  it('adds multiple native accounts and reports the active account independently of quota', async () => {
    const firstBackend = backend(first)
    const firstAccount = createSyntheticAntigravityAccount(first, 1)
    const secondAccount = createSyntheticAntigravityAccount(second, 2)
    const store = createMemoryAntigravityAccountStore([firstAccount])
    const service = new AntigravityAccountService(store, firstBackend, () => 3)
    await service.addCurrentAccount()
    firstBackend.current = second
    await service.addCurrentAccount()
    const state = await service.listAccounts()
    expect(state.accounts).toHaveLength(2)
    expect(state.activeAccountId).toBe(secondAccount.id.split('-').slice(0, 2).join('-'))
  })

  it('switches the live native credential and verifies readback', async () => {
    const active = backend(first)
    const account = createSyntheticAntigravityAccount(second)
    const service = new AntigravityAccountService(
      createMemoryAntigravityAccountStore([account]),
      active
    )
    const state = await service.selectAccount(account.id)
    expect(active.current).toBe(second)
    expect(state.activeAccountId).toBe(account.id)
  })

  it('keeps the active account when readback fails', async () => {
    const active = backend(first)
    const account = createSyntheticAntigravityAccount(second)
    active.read = async () => ({ contents: first, authMethod: 'consumer', identity: null })
    const service = new AntigravityAccountService(
      createMemoryAntigravityAccountStore([account]),
      active
    )
    await expect(service.selectAccount(account.id)).rejects.toThrow('could not be verified')
  })

  it('does not remove the active account or allow an unknown id', async () => {
    const active = backend(first)
    const account = createSyntheticAntigravityAccount(first)
    const service = new AntigravityAccountService(
      createMemoryAntigravityAccountStore([account]),
      active
    )
    await service.listAccounts()
    await expect(service.removeAccount(account.id)).rejects.toThrow('active account')
    await expect(service.selectAccount('missing')).rejects.toThrow('was not found')
  })
})
