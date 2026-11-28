import { expect, it, vi } from 'vitest'
import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { directoryAccountBinding } from '../launch/acp-account-binding'
import { AcpListingRefused, prepareAcpListingAccount } from './acp-listing-account'

const binding = directoryAccountBinding('GEMINI_HOME', (home) => home)
const failingWith = (error: Error) => ({
  account: {
    ...binding,
    prepare: async () => {
      throw error
    }
  }
})

const auth: AntigravityChatAuthConfig = { method: 'gemini-api-key' }

it('lists anyway when the account files fail, but not on an account that refuses the listing', async () => {
  const assertCurrent = vi.fn()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const failing = failingWith(new Error('disk full'))
  await expect(prepareAcpListingAccount(failing, {}, auth, assertCurrent)).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalled()
  const refused = new AcpListingRefused('no key')
  const refusing = failingWith(refused)
  await expect(prepareAcpListingAccount(refusing, {}, auth, assertCurrent)).rejects.toBe(refused)
  expect(assertCurrent).toHaveBeenCalledTimes(1)
  warn.mockRestore()
})
