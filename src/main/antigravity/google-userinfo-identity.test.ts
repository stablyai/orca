import { afterEach, describe, expect, it } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { fetchGoogleIdentity } from './google-userinfo-identity'

const TOKEN = 'synthetic-access-token'

function respond(fetch: () => Promise<Response>): void {
  setMainHttpClient({ fetch, proxySession: () => null })
}

afterEach(() => setMainHttpClient(null))

describe('fetchGoogleIdentity', () => {
  it('reads the subject and only a verified email', async () => {
    respond(async () => Response.json({ sub: 's', email: 'a@example.invalid' }))
    await expect(fetchGoogleIdentity(TOKEN)).resolves.toMatchObject({ subject: 's', email: null })
  })

  it.each([
    async () => {
      throw new Error(`request failed for Bearer ${TOKEN}`)
    },
    async () => new Response(`invalid ${TOKEN}`, { status: 401 }),
    async () => new Response(`denied ${TOKEN}`, { status: 403 }),
    async () => Response.json({ error: TOKEN })
  ])('fails without echoing the token or the response', async (fetch) => {
    respond(fetch)
    const error = await fetchGoogleIdentity(TOKEN).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(TOKEN)
  })
})
