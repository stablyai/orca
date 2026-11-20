import { afterEach, describe, expect, it } from 'vitest'
import {
  connectedGoogle,
  fakeGoogle,
  googleJson,
  NOW,
  type FakeRoute
} from './google-api.test-fixture'

let cleanup = (): void => {}
afterEach(() => cleanup())

async function apiWith(routes: FakeRoute[]) {
  const google = await connectedGoogle()
  cleanup = google.cleanup
  const seen: { method: string; url: string; type: string | null; body: unknown }[] = []
  const fake = fakeGoogle([
    (url, init) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: url.toString(),
        type: new Headers(init?.headers).get('content-type'),
        body: init?.body
      })
      return null
    },
    ...routes
  ])
  return {
    api: await google.client.googleApi(undefined, { http: fake.http, now: () => NOW }),
    seen
  }
}

const DOCS = 'https://docs.googleapis.com/v1/documents'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const readId = (body: unknown) =>
  typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string'
    ? body.id
    : null

describe('Google writes', () => {
  it('sends a raw body with its own content type', async () => {
    const { api, seen } = await apiWith([() => googleJson(200, { id: 'f1' })])
    const body = new TextEncoder().encode('a,b\n1,2')
    await api.send(
      'drive',
      { method: 'PATCH', url: `${DRIVE}/f1`, raw: { body, contentType: 'text/csv' } },
      readId
    )
    expect(seen[0]).toMatchObject({ method: 'PATCH', type: 'text/csv', body })
  })

  it('renews a refused token once and resends the same JSON write', async () => {
    const { api, seen } = await apiWith([
      (url) =>
        url.hostname === 'oauth2.googleapis.com'
          ? googleJson(200, { access_token: 'at-2', expires_in: 3600 })
          : null,
      (_url, init) =>
        new Headers(init?.headers).get('authorization') === 'Bearer at-1'
          ? googleJson(401, { error: { code: 401 } })
          : googleJson(200, { id: 'doc-1' })
    ])
    await expect(
      api.send('docs', { method: 'POST', url: DOCS, json: { title: 'Plan' } }, readId)
    ).resolves.toBe('doc-1')
    const write = { method: 'POST', url: DOCS, type: 'application/json', body: '{"title":"Plan"}' }
    expect(seen.filter((call) => call.url === DOCS)).toEqual([write, write])
    expect(seen.filter((call) => call.url === 'https://oauth2.googleapis.com/token')).toHaveLength(
      1
    )
  })

  it("says the account's own reason when renewal fails, instead of retrying with nothing", async () => {
    const { api, seen } = await apiWith([
      (url) =>
        url.hostname === 'oauth2.googleapis.com'
          ? googleJson(400, { error: 'invalid_grant' })
          : null,
      () => googleJson(401, { error: { code: 401 } })
    ])
    await expect(api.send('docs', { method: 'POST', url: DOCS, json: {} }, readId)).rejects.toThrow(
      'Ask your owner to reconnect it in Orca.'
    )
    expect(seen.filter((call) => call.url === DOCS)).toHaveLength(1)
  })
})

describe('Google downloads', () => {
  const file = (size: number, withLength: boolean) =>
    new Response(new Uint8Array(size).fill(7), {
      status: 200,
      headers: withLength ? { 'content-length': String(size) } : {}
    })

  it('returns the bytes of a file under the cap', async () => {
    const { api } = await apiWith([() => file(1_000, true)])
    const bytes = await api.bytes('drive', `${DRIVE}/f1?alt=media`, 2_000)
    expect(bytes.byteLength).toBe(1_000)
    expect(bytes[0]).toBe(7)
  })

  it('refuses a file whose stated size is over the cap, before reading it', async () => {
    const { api } = await apiWith([() => file(1_500_000, true)])
    await expect(api.bytes('drive', `${DRIVE}/f1?alt=media`, 1_000_000)).rejects.toThrow(
      'larger than 1 MB'
    )
  })

  it('refuses a file that streams past the cap without a stated size', async () => {
    const { api } = await apiWith([() => file(3_000_000, false)])
    await expect(api.bytes('drive', `${DRIVE}/f1?alt=media`)).rejects.toThrow(
      'larger than 2.9 MB, more than Orca hands an agent at once. Open it in Google instead.'
    )
  })
})
