import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCursorAccountStatus } from './status'
import { readCursorAuthSession } from '../rate-limits/cursor-auth'
import { isCursorSessionTokenExpired } from '../rate-limits/cursor-session-token'

vi.mock('../rate-limits/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../rate-limits/cursor-session-token', () => ({ isCursorSessionTokenExpired: vi.fn() }))

const disconnected = {
  signedIn: false,
  email: null,
  displayName: null,
  credentialSource: null,
  planType: null,
  tokenFresh: false,
  error: null
}

describe('getCursorAccountStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not probe CLI files or keychain when detection is disabled', async () => {
    expect(await getCursorAccountStatus({ automaticallyDetectAiAccounts: false })).toEqual(
      disconnected
    )
    expect(readCursorAuthSession).not.toHaveBeenCalled()
    expect(isCursorSessionTokenExpired).not.toHaveBeenCalled()
  })

  it('redacts a pending identity when the host disables detection', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<typeof readCursorAuthSession>>>()
    vi.mocked(readCursorAuthSession).mockReturnValueOnce(read.promise)
    let enabled = true
    const status = getCursorAccountStatus(() => ({ automaticallyDetectAiAccounts: enabled }))
    enabled = false
    read.resolve({
      status: 'ok',
      session: {
        token: { raw: 'private-token', subject: 'private', expiresAtMs: null },
        email: 'private@example.invalid',
        displayName: 'Private',
        source: 'cli',
        membershipType: 'pro',
        subscriptionStatus: 'active'
      }
    })
    expect(await status).toEqual(disconnected)
    expect(isCursorSessionTokenExpired).not.toHaveBeenCalled()
  })

  it.each([undefined, true])('retains discovery when the setting is %s', async (enabled) => {
    vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
    expect(await getCursorAccountStatus({ automaticallyDetectAiAccounts: enabled })).toEqual(
      disconnected
    )
    expect(readCursorAuthSession).toHaveBeenCalledOnce()
  })
})
