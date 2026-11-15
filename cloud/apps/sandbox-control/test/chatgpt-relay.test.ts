import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createIdTokenSource, relayingFetch } from '../src/chatgpt-relay'

const RELAY = 'https://orca-chatgpt-relay-abc.us-central1.run.app'

function idTokenFor(exp: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc({ exp, aud: RELAY })}.sig`
}

async function serviceAccount() {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true })
  return JSON.stringify({ client_email: 'relay-invoker@p.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) })
}

describe('relayingFetch (CODEX-RELAY)', () => {
  it('sends chatgpt.com through the relay with an ID token beside, never instead of, the ChatGPT credential', async () => {
    const seen: { url: string; headers: Headers }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('ok')
    }) as typeof fetch
    const relayed = relayingFetch({ relayUrl: RELAY, idToken: async () => 'google-id', fetch: fetchImpl })
    await relayed('https://chatgpt.com/backend-api/codex/models?client_version=0.166.0', { headers: { authorization: 'Bearer chatgpt-real' } })
    await relayed('https://api.anthropic.com/v1/messages', { headers: { authorization: 'Bearer other' } })
    expect(seen[0]!.url).toBe(`${RELAY}/backend-api/codex/models?client_version=0.166.0`)
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer chatgpt-real')
    expect(seen[0]!.headers.get('x-serverless-authorization')).toBe('Bearer google-id')
    // Every other host goes direct, with no relay token.
    expect(seen[1]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[1]!.headers.get('x-serverless-authorization')).toBeNull()
  })

  it('without a relay URL chatgpt.com goes direct, as before', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => (urls.push(String(input)), new Response('ok'))) as typeof fetch
    await relayingFetch({ fetch: fetchImpl })('https://chatgpt.com/backend-api/wham/usage')
    expect(urls).toEqual(['https://chatgpt.com/backend-api/wham/usage'])
  })

  it('a relay sign-in failure answers in ChatGPT’s error shape (Codex prints it), never reaching chatgpt.com', async () => {
    let calls = 0
    const fetchImpl = (async () => (calls++, new Response('ok'))) as typeof fetch
    const res = await relayingFetch({
      relayUrl: RELAY,
      idToken: async () => {
        throw new Error('no')
      },
      fetch: fetchImpl
    })('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { detail: string }).detail).toContain('ChatGPT')
    expect(calls).toBe(0)
  })
})

describe('createIdTokenSource', () => {
  it('mints with target_audience = the relay URL, and reuses the token until 5 minutes before it expires', async () => {
    let now = 1_800_000_000_000
    const assertions: string[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assertions.push(new URLSearchParams(String(init?.body)).get('assertion')!)
      return Response.json({ id_token: idTokenFor(Math.floor(now / 1000) + 3600) })
    }) as typeof fetch
    const source = createIdTokenSource({ serviceAccountJson: await serviceAccount(), audience: RELAY, fetch: fetchImpl, now: () => now })
    const first = await source()
    expect(await source()).toBe(first)
    expect(assertions).toHaveLength(1)
    const claims = decodeJwt(assertions[0]!)
    expect(claims).toMatchObject({ target_audience: RELAY, aud: 'https://oauth2.googleapis.com/token', iss: 'relay-invoker@p.iam.gserviceaccount.com' })
    now += 56 * 60_000
    await source()
    expect(assertions).toHaveLength(2)
  })

  it('a refused mint throws (the caller answers 503) and the next call tries again', async () => {
    let ok = false
    const fetchImpl = (async () => (ok ? Response.json({ id_token: idTokenFor(4e9) }) : new Response('{}', { status: 400 }))) as typeof fetch
    const source = createIdTokenSource({ serviceAccountJson: await serviceAccount(), audience: RELAY, fetch: fetchImpl })
    await expect(source()).rejects.toThrow()
    ok = true
    await expect(source()).resolves.toContain('.')
  })
})
