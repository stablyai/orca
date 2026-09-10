import { loadLinearSdk } from './linear-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireIssueListPage } from './mcp-issue-list-acquisition'
import { JsonTextStructureCapacityError } from '../../shared/json-text-structure-limit'

afterEach(() => vi.unstubAllGlobals())
const variables = { first: 250, orderBy: 'updatedAt' }
const signal = new AbortController().signal
function node(id: number) {
  return {
    id: String(id),
    identifier: `F-${id}`,
    title: 'Fixture',
    url: 'https://linear.app/fixture'
  }
}
function response(nodes: unknown[]) {
  return { data: { issues: { nodes, pageInfo: { hasNextPage: false } } } }
}

describe('Linear bounded acquisition adapter', () => {
  it('uses the installed SDK public account options including auth, headers and endpoint', async () => {
    const client = new (loadLinearSdk().LinearClient)({
      accessToken: 'synthetic-access',
      apiUrl: 'https://fixture.invalid/graphql',
      headers: { 'X-Fixture': 'present' }
    })
    const fetch = vi.fn(async () => Response.json(response([])))
    vi.stubGlobal('fetch', fetch)
    await acquireIssueListPage(client.options, variables, signal)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://fixture.invalid/graphql')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer synthetic-access')
    expect(headers.get('X-Fixture')).toBe('present')
    expect(headers.get('User-Agent')).toBe(new Headers(client.options.headers).get('User-Agent'))
    expect(init.signal).toBe(signal)
  })
  it('keeps full250x50-label projection, null/absence and valid Unicode including JSON lone surrogates', async () => {
    const nodes = Array.from({ length: 250 }, (_, i) => ({
      ...node(i),
      ...(i === 0 ? { description: '😀\ud800\\\n' } : i === 1 ? { description: null } : {}),
      labels: {
        nodes: Array.from({ length: 50 }, (_, label) => ({
          id: String(label),
          name: 'Label',
          color: '#ffffff'
        })),
        pageInfo: { hasNextPage: true }
      }
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response(nodes)))
    )
    const page = await acquireIssueListPage({ apiKey: 'synthetic' }, variables, signal)
    expect(page.nodes).toHaveLength(250)
    expect(page.nodes[0].description).toBe('😀\ud800\\\n')
    expect(page.nodes[1].description).toBeNull()
    expect(page.nodes[2]).not.toHaveProperty('description')
    expect(page.nodes[249].labels?.nodes).toHaveLength(50)
  })
  it('rejects over-depth JSON before mapping even when the issue projection is otherwise valid', async () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 33; depth++) {
      nested = [nested]
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...response([node(0)]), nested }))
    )
    await expect(
      acquireIssueListPage({ apiKey: 'synthetic' }, variables, signal)
    ).rejects.toBeInstanceOf(JsonTextStructureCapacityError)
  })
  it('refuses high-level-only adapters that bypass streaming acquisition', async () => {
    const json = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json }))
    )
    await expect(
      acquireIssueListPage({ apiKey: 'synthetic' }, variables, signal)
    ).rejects.toMatchObject({ code: 'linear_list_invalid_response' })
    expect(json).not.toHaveBeenCalled()
  })
  it.each(['AuthenticationError', 'Forbidden', 'Ratelimited'])(
    'classifies GraphQL %s without copying provider text',
    async (type) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            errors: [{ message: 'untrusted provider details', extensions: { type } }]
          })
        )
      )
      await expect(
        acquireIssueListPage({ apiKey: 'synthetic' }, variables, signal)
      ).rejects.toMatchObject({
        code:
          type === 'AuthenticationError'
            ? 'linear_auth_expired'
            : type === 'Forbidden'
              ? 'linear_permission_denied'
              : 'linear_rate_limited',
        message: 'Linear returned a GraphQL error.'
      })
    }
  )
})
