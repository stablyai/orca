import { describe, expect, it } from 'vitest'
import { checkGoogleClientKey } from './google-client-check'
import type { GoogleHttp } from './google-token-endpoint'

const answering =
  (body: unknown, status = 400): GoogleHttp =>
  async () =>
    new Response(JSON.stringify(body), { status })

const client = { clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' }

describe("checking the app key with Google's token endpoint", () => {
  it('reads a made-up code refused as invalid_grant as a key that works', async () => {
    await expect(checkGoogleClientKey(answering({ error: 'invalid_grant' }), client)).resolves.toBe(
      'works'
    )
  })

  it('reads invalid_client as a key Google no longer knows', async () => {
    await expect(
      checkGoogleClientKey(
        answering(
          { error: 'invalid_client', error_description: 'The OAuth client was not found.' },
          401
        ),
        client
      )
    ).resolves.toBe('gone')
    await expect(
      checkGoogleClientKey(answering({ error: 'deleted_client' }, 401), client)
    ).resolves.toBe('gone')
  })

  it("can't tell from anything else, or no answer", async () => {
    await expect(
      checkGoogleClientKey(answering({ error: 'rate_limited' }, 429), client)
    ).resolves.toBe('unknown')
    const offline: GoogleHttp = async () => {
      throw new Error('offline')
    }
    await expect(checkGoogleClientKey(offline, client)).resolves.toBe('unknown')
  })

  it('sends the key and a made-up code, never a real one', async () => {
    let sent = ''
    const http: GoogleHttp = async (_url, init) => {
      sent = String(init?.body)
      return new Response('{"error":"invalid_grant"}', { status: 400 })
    }
    await checkGoogleClientKey(http, client)
    expect(new URLSearchParams(sent).get('code')).toBe('orca-key-check')
    expect(new URLSearchParams(sent).get('client_id')).toBe(client.clientId)
  })
})
