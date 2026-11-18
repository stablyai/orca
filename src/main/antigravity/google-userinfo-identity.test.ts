import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { fetchGoogleIdentity } from './google-userinfo-identity'

const TOKEN = 'synthetic-access-token'

function respond(fetch: () => Promise<Response>): void {
  setMainHttpClient({ fetch, proxySession: () => null })
}

afterEach(() => setMainHttpClient(null))

describe('fetchGoogleIdentity', () => {
  it.each([true, false])(
    'reads identity with email_verified=%s through a header-only request',
    async (verified) => {
      const fetch = vi.fn(async () =>
        Response.json({ sub: 's', email: 'a@example.invalid', email_verified: verified })
      )
      respond(fetch)
      await expect(fetchGoogleIdentity(TOKEN)).resolves.toEqual({
        issuer: 'https://accounts.google.com',
        subject: 's',
        email: verified ? 'a@example.invalid' : null
      })
      expect(fetch).toHaveBeenCalledWith('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${TOKEN}` },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    }
  )

  it('rejects an oversized identity response', async () => {
    respond(async () => Response.json({ sub: 's', padding: 'x'.repeat(16 * 1024) }))
    await expect(fetchGoogleIdentity(TOKEN)).rejects.toThrow('Google did not confirm')
  })

  it.each([
    {
      fetch: async () => {
        throw new Error(`request failed for Bearer ${TOKEN}`)
      },
      message: 'Could not reach Google to identify the Antigravity account; nothing was saved.'
    },
    {
      fetch: async () => new Response(`invalid ${TOKEN}`, { status: 401 }),
      message:
        'Google rejected the current Antigravity credential. Run agy once to refresh it, then save again.'
    },
    {
      fetch: async () => new Response(`denied ${TOKEN}`, { status: 403 }),
      message: 'Google did not confirm the signed-in Antigravity account; nothing was saved.'
    },
    {
      fetch: async () => new Response(TOKEN),
      message: 'Google did not confirm the signed-in Antigravity account; nothing was saved.'
    }
  ])('returns a fixed, secret-free error: $message', async ({ fetch, message }) => {
    respond(fetch)
    await expect(fetchGoogleIdentity(TOKEN)).rejects.toEqual(new Error(message))
  })
})
