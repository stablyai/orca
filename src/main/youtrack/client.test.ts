import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), saveSite: vi.fn() }))

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: mocks.fetch, proxySession: () => null })
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => undefined)
}))
vi.mock('./credential-store', () => ({
  clearSite: vi.fn(),
  getCredentialError: vi.fn(() => null),
  getSite: vi.fn(() => null),
  getTokenProtection: vi.fn(() => null),
  readToken: vi.fn(() => null),
  saveSite: mocks.saveSite
}))

const { buildIssueQuery, connect } = await import('./client')

describe('connect', () => {
  const viewer = (): Response =>
    new Response(JSON.stringify({ id: '1-1', login: 'me', fullName: 'Me' }), { status: 200 })

  it('falls back to the path as entered when the trimmed root is not YouTrack', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith('https://corp.example.com/projects/yt/api/')
        ? viewer()
        : new Response('{}', { status: 404 })
    )
    const result = await connect({ baseUrl: 'https://corp.example.com/projects/yt', token: 't' })
    expect(result.ok).toBe(true)
    expect(mocks.saveSite).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://corp.example.com/projects/yt' }),
      't'
    )
  })

  it('tries the path as entered when the root rejects the token, keeping the root error', async () => {
    mocks.fetch.mockReset()
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith('https://corp.example.com/projects/yt/api/')
        ? viewer()
        : new Response('{}', { status: 401 })
    )
    await expect(
      connect({ baseUrl: 'https://corp.example.com/projects/yt', token: 't' })
    ).resolves.toMatchObject({ ok: true })

    mocks.fetch.mockReset()
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 401 }))
    const result = await connect({ baseUrl: 'https://corp.example.com/projects/yt', token: 't' })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/token/) })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('buildIssueQuery', () => {
  it('maps presets to YouTrack queries sorted by update time', () => {
    expect(buildIssueQuery({ preset: 'assigned' })).toBe(
      'Assignee: me #Unresolved sort by: updated desc'
    )
    expect(buildIssueQuery({})).toBe('Assignee: me #Unresolved sort by: updated desc')
  })

  it('prefers a custom query and keeps its own sort', () => {
    expect(buildIssueQuery({ preset: 'done', query: ' project: APP ' })).toBe(
      'project: APP sort by: updated desc'
    )
    expect(buildIssueQuery({ query: 'project: APP sort by: priority' })).toBe(
      'project: APP sort by: priority'
    )
  })
})
