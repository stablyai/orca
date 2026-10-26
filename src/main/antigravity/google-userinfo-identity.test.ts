import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGoogleUserinfoResolver } from './google-userinfo-identity'

const TOKEN = 'synthetic-access-token-never-logged'

function resolverFor(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(respond)
  return { fetch, resolve: createGoogleUserinfoResolver(() => ({ fetch })) }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Google userinfo identity lookup', () => {
  it('sends the bearer token to the fixed Google userinfo URL and nothing else', async () => {
    const { fetch, resolve } = resolverFor(async () => json({ sub: 'subject-1' }))
    await resolve(TOKEN)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(init.body).toBeUndefined()
  })

  it('returns the Google subject and a verified email', async () => {
    const { resolve } = resolverFor(async () =>
      json({ sub: 'subject-1', email: 'a@example.invalid', email_verified: true, name: 'Ignored' })
    )
    await expect(resolve(TOKEN)).resolves.toEqual({
      subject: 'subject-1',
      email: 'a@example.invalid'
    })
  })

  it.each([
    ['unverified', { sub: 's', email: 'a@example.invalid', email_verified: false }],
    ['missing verification', { sub: 's', email: 'a@example.invalid' }],
    ['blank', { sub: 's', email: '  ', email_verified: true }],
    ['non-string', { sub: 's', email: 7, email_verified: true }]
  ])('labels the account with no email when it is %s', async (_label, body) => {
    const { resolve } = resolverFor(async () => json(body))
    await expect(resolve(TOKEN)).resolves.toEqual({ subject: 's', email: null })
  })

  it.each([401, 403])('tells the user to refresh agy when Google answers %i', async (status) => {
    const { resolve } = resolverFor(async () => json({ error: 'invalid_token' }, status))
    await expect(resolve(TOKEN)).rejects.toThrow('Run agy once to refresh it')
  })

  it.each([400, 429, 500, 503])(
    'does not confirm the account when Google answers %i',
    async (s) => {
      const { resolve } = resolverFor(async () => json({}, s))
      await expect(resolve(TOKEN)).rejects.toThrow('did not confirm')
    }
  )

  it.each([
    ['no sub', { email: 'a@example.invalid', email_verified: true }],
    ['an empty sub', { sub: '' }],
    ['a blank sub', { sub: '   ' }],
    ['a non-string sub', { sub: 12345 }],
    ['an oversized sub', { sub: 'x'.repeat(257) }],
    ['an array body', [{ sub: 'subject-1' }]],
    ['a null body', null]
  ])('does not confirm the account for %s', async (_label, body) => {
    const { resolve } = resolverFor(async () => json(body))
    await expect(resolve(TOKEN)).rejects.toThrow('did not confirm')
  })

  it('does not confirm the account for a body that is not JSON or is oversized', async () => {
    const notJson = resolverFor(async () => new Response('<html>nope</html>', { status: 200 }))
    await expect(notJson.resolve(TOKEN)).rejects.toThrow('did not confirm')
    const oversized = resolverFor(async () => json({ sub: 's', padding: 'x'.repeat(20_000) }))
    await expect(oversized.resolve(TOKEN)).rejects.toThrow('did not confirm')
  })

  it('reports an unreachable Google when the request itself fails', async () => {
    const { resolve } = resolverFor(async () => {
      throw new Error(`connect failed with ${TOKEN} in the message`)
    })
    await expect(resolve(TOKEN)).rejects.toThrow('Could not reach Google')
  })

  it('never puts the token or Google’s body in an error', async () => {
    const failures = [
      resolverFor(async () => json({ error_description: `echo ${TOKEN}` }, 401)),
      resolverFor(async () => json({ error_description: `echo ${TOKEN}` }, 500)),
      resolverFor(async () => {
        throw new Error(TOKEN)
      })
    ]
    for (const failure of failures) {
      const error = await failure.resolve(TOKEN).catch((cause: unknown) => cause)
      expect(String(error)).not.toContain(TOKEN)
      expect(String(error)).not.toContain('echo')
    }
  })

  it('discards the response body of a refused request instead of leaving it unread', async () => {
    const cancel = vi.fn(async () => undefined)
    const body = new ReadableStream({ cancel })
    const { resolve } = resolverFor(async () => new Response(body, { status: 401 }))
    await expect(resolve(TOKEN)).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
  })

  it('gives up after ten seconds and aborts the request', async () => {
    vi.useFakeTimers()
    let aborted = false
    const { resolve } = resolverFor(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
    )
    const result = resolve(TOKEN).catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(String(await result)).toContain('Could not reach Google')
    expect(aborted).toBe(true)
  })
})
