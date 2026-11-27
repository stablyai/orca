import { expect, it } from 'vitest'
import { googleApi, EMAIL, NOW } from './google-api-http.test-fixture'

const FILE_URL = 'https://www.googleapis.com/drive/v3/files/document'

it('releases the rejected response before renewing a token and retrying', async () => {
  let cancelled = false
  let cancelledBeforeRefresh = false
  const refused = new Response(
    new ReadableStream({
      cancel: () => {
        cancelled = true
      }
    }),
    {
      status: 401
    }
  )
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input, options) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        cancelledBeforeRefresh = cancelled
        return Response.json({ access_token: 'new-token', expires_in: 3600 })
      }
      const authorization = new Headers(options?.headers).get('authorization')
      return authorization === 'Bearer old-token' ? refused : Response.json({ id: 'document' })
    }
  })

  expect(await api.get('drive', FILE_URL, (body) => body)).toEqual({ id: 'document' })
  expect(cancelledBeforeRefresh).toBe(true)

  const refusedApi = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) =>
      String(input) === 'https://oauth2.googleapis.com/token'
        ? Response.json({ access_token: 'new-token', expires_in: 3600 })
        : Response.json({ error: { message: 'Sign-in refused' } }, { status: 401 })
  })
  await expect(refusedApi.get('drive', FILE_URL, (body) => body)).rejects.toThrow(
    'Google refused the sign-in'
  )
})

it('releases a missing file response while preserving find returning null', async () => {
  let cancelled = false
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true
          }
        }),
        {
          status: 404
        }
      )
  })

  expect(await api.find('drive', FILE_URL, (body) => body)).toBeNull()
  expect(cancelled).toBe(true)
})
