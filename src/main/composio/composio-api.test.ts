import { describe, expect, it, vi } from 'vitest'
import { ComposioApi, ComposioKeyRejectedError, ComposioLimitError } from './composio-api'

const answering = (status: number, body: unknown) =>
  new ComposioApi(
    'ak_test',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )

// Trimmed from Composio's own answers for each sign-in kind (captured 2026-11-04).
const TOOLKITS = {
  notion: {
    slug: 'notion',
    name: 'Notion',
    auth_schemes: null,
    composio_managed_auth_schemes: ['OAUTH2'],
    auth_config_details: [{ mode: 'OAUTH2' }, { mode: 'API_KEY' }]
  },
  twitter: {
    slug: 'twitter',
    name: 'Twitter',
    composio_managed_auth_schemes: [],
    auth_config_details: [{ mode: 'OAUTH2' }]
  },
  tavily: {
    slug: 'tavily',
    name: 'Tavily',
    composio_managed_auth_schemes: [],
    auth_config_details: [{ mode: 'API_KEY' }]
  },
  hackernews: {
    slug: 'hackernews',
    name: 'Hacker News',
    composio_managed_auth_schemes: [],
    auth_config_details: [{ mode: 'NO_AUTH' }]
  }
}

describe('Composio answers', () => {
  it.each([
    ['notion', 'composio'],
    ['twitter', 'own'],
    ['tavily', 'key'],
    ['hackernews', 'none']
  ] as const)('reads how %s signs in', async (slug, signIn) => {
    const toolkit = { ...TOOLKITS[slug], auth_schemes: undefined }
    expect((await answering(200, toolkit).app(slug)).signIn).toBe(signIn)
  })

  it('reads sign-in kinds in either case, and from details when the list is empty', async () => {
    const lower = {
      slug: 'x',
      name: 'X',
      auth_schemes: [],
      auth_config_details: [{ mode: 'api_key' }]
    }
    expect((await answering(200, lower).app('x')).signIn).toBe('key')
    const none = { slug: 'y', name: 'Y', auth_schemes: ['no_auth'] }
    expect((await answering(200, none).app('y')).signIn).toBe('none')
  })

  it('refuses the key only on 401; a 403 is one endpoint the key may not use', async () => {
    await expect(answering(401, {}).app('x')).rejects.toBeInstanceOf(ComposioKeyRejectedError)
    const forbidden = answering(403, { error: { slug: 'Auth_ProjectAPIKeyNotAllowed' } })
    await expect(forbidden.app('x')).rejects.not.toBeInstanceOf(ComposioKeyRejectedError)
  })

  it('tells a burst from the plan’s cap by the answer’s words', async () => {
    const monthly = answering(429, { error: { message: 'Monthly usage limit reached' } })
    await expect(monthly.app('x')).rejects.toMatchObject({ retryAt: null })
    const burst = answering(429, { error: { message: 'Too many requests' } })
    await expect(burst.app('x')).rejects.toMatchObject({ retryAt: expect.any(Number) })
    const payment = answering(402, {})
    await expect(payment.app('x')).rejects.toBeInstanceOf(ComposioLimitError)
  })
})
