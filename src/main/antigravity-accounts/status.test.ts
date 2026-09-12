import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAntigravityAccountStatus } from './status'
import { access, readFile } from 'node:fs/promises'

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn()
}))

describe('getAntigravityAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'))
  })

  it('reports unsigned status when no credentials or accounts exist', async () => {
    const status = await getAntigravityAccountStatus()
    expect(status).toEqual({
      signedIn: false,
      email: null,
      tokenFresh: false,
      error: null
    })
  })

  it('reports signed in with email when google_accounts.json has active user', async () => {
    vi.mocked(access).mockImplementation(async (p) => {
      if (String(p).includes('google_accounts.json')) {
        return undefined
      }
      throw new Error('ENOENT')
    })
    vi.mocked(readFile).mockImplementation(async (p) => {
      if (String(p).includes('google_accounts.json')) {
        return JSON.stringify({ active: 'test@gmail.com', old: [] })
      }
      throw new Error('ENOENT')
    })

    const status = await getAntigravityAccountStatus()
    expect(status).toEqual({
      signedIn: true,
      email: 'test@gmail.com',
      tokenFresh: false,
      error: null
    })
  })

  it('reports signed in with tokenFresh true when oauth_creds.json is not expired', async () => {
    vi.mocked(access).mockResolvedValue(undefined)
    vi.mocked(readFile).mockImplementation(async (p) => {
      if (String(p).includes('google_accounts.json')) {
        return JSON.stringify({ active: 'test@gmail.com' })
      }
      if (String(p).includes('oauth_creds.json')) {
        return JSON.stringify({
          access_token: 'valid_access_token',
          expiry_date: Date.now() + 3600_000
        })
      }
      throw new Error('ENOENT')
    })

    const status = await getAntigravityAccountStatus()
    expect(status).toEqual({
      signedIn: true,
      email: 'test@gmail.com',
      tokenFresh: true,
      error: null
    })
  })

  it('reports tokenFresh false when oauth_creds.json is expired', async () => {
    vi.mocked(access).mockResolvedValue(undefined)
    vi.mocked(readFile).mockImplementation(async (p) => {
      if (String(p).includes('google_accounts.json')) {
        return JSON.stringify({ active: 'test@gmail.com' })
      }
      if (String(p).includes('oauth_creds.json')) {
        return JSON.stringify({
          access_token: 'expired_access_token',
          expiry_date: Date.now() - 3600_000
        })
      }
      throw new Error('ENOENT')
    })

    const status = await getAntigravityAccountStatus()
    expect(status).toEqual({
      signedIn: true,
      email: 'test@gmail.com',
      tokenFresh: false,
      error: null
    })
  })
})
