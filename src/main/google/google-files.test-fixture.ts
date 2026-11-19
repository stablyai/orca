// A fake Google for the Drive, Docs and Sheets tests that also keeps each request's method and body.
import { connectedGoogle, fakeGoogle, NOW, type FakeRoute } from './google-api.test-fixture'

export type SentRequest = { method: string; url: URL; body: unknown; raw?: string }

function bodyOf(init: RequestInit | undefined): { raw?: string; body: unknown } {
  const raw =
    typeof init?.body === 'string'
      ? init.body
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body).toString('utf8')
        : undefined
  if (raw === undefined) {
    return { body: undefined }
  }
  try {
    return { raw, body: JSON.parse(raw) }
  } catch {
    return { raw, body: undefined }
  }
}

/** A connected account answering through `routes`, and every request it was sent. */
export async function filesApi(routes: FakeRoute[]) {
  const google = await connectedGoogle()
  const sent: SentRequest[] = []
  const fake = fakeGoogle([
    (url, init) => {
      sent.push({ method: init?.method ?? 'GET', url, ...bodyOf(init) })
      return null
    },
    ...routes
  ])
  return {
    api: google.client.googleApi(undefined, { http: fake.http, now: () => NOW }),
    sent,
    writes: () => sent.filter((request) => request.method !== 'GET'),
    cleanup: google.cleanup
  }
}

/** A route for one method and path. */
export const route =
  (
    method: string,
    path: string | RegExp,
    answer: (url: URL, body: unknown) => Response
  ): FakeRoute =>
  (url, init) => {
    const matches = typeof path === 'string' ? url.pathname === path : path.test(url.pathname)
    if (!matches || (init?.method ?? 'GET') !== method) {
      return null
    }
    return answer(url, bodyOf(init).body)
  }

export const bytesResponse = (data: Uint8Array | string, type: string) =>
  new Response(typeof data === 'string' ? data : new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': type }
  })
