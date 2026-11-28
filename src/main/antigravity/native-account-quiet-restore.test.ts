import { expect, it, vi } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import { credential, harness } from './native-account-test-fixtures'

// Two saved accounts, `b` selected, and agy's keychain item rewritten since Orca last read it: a
// read of the login that names it could raise a keychain dialog.
async function drifted() {
  const h = harness(credential('a'))
  await h.service.addCurrentAccount()
  h.setNative(credential('b'))
  const { accounts } = await h.service.addCurrentAccount()
  await h.service.selectAccount(accounts.find((account) => account.subject === 'b')!.id)
  h.setNative(credential('a'))
  const backend = {
    ...h.backend,
    readWithoutPrompt: vi.fn(async () => ({
      fingerprint: 'rewritten',
      stableFrom: 0,
      settled: true
    }))
  }
  vi.mocked(h.backend.read).mockClear()
  const service = new AntigravityAccountService(h.store, backend, Date.now, h.lookupIdentity, {
    signInHoldsLogin: () => false
  })
  return { h, service }
}

it('never reads a login only a keychain dialog could name when nobody asked for the restore', async () => {
  const { h, service } = await drifted()
  await service.prepareForLaunch({ mayPrompt: false, quiet: true })
  expect(h.backend.read).not.toHaveBeenCalled()
  expect(h.getNative()).toBe(credential('a'))
})
