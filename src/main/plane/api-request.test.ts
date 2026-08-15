import { afterEach, describe, expect, it, vi } from 'vitest'
import { planeFetch } from './api-request'
import type { PlaneClientForInstance } from './client'

const writeTokenMock = vi.hoisted(() => vi.fn())

vi.mock('./instance-storage', () => ({ writeToken: writeTokenMock }))

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function fetchHeaders(fetchMock: ReturnType<typeof vi.spyOn>, call = 0): Headers {
  return fetchMock.mock.calls[call]?.[1]?.headers as Headers
}

describe('Plane API requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    writeTokenMock.mockReset()
  })

  it('uses X-API-Key for personal access token connections', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: true }))
    const client: PlaneClientForInstance = {
      instance: {
        id: 'plane-1',
        baseUrl: 'https://plane.example',
        workspaceSlug: 'acme',
        displayName: 'Acme'
      },
      auth: { kind: 'apiKey', apiKey: 'pat-token' }
    }

    await planeFetch(client, '/api/v1/users/me/')

    expect(fetchHeaders(fetchMock).get('X-API-Key')).toBe('pat-token')
  })

  it('uses bearer auth for OAuth connections', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: true }))
    const client: PlaneClientForInstance = {
      instance: {
        id: 'plane-1',
        baseUrl: 'https://plane.example',
        workspaceSlug: 'acme',
        displayName: 'Acme',
        authMode: 'oauth'
      },
      auth: {
        kind: 'oauth',
        accessToken: 'oauth-token',
        clientId: 'client-id',
        clientSecret: 'client-secret'
      }
    }

    await planeFetch(client, '/api/v1/users/me/')

    expect(fetchHeaders(fetchMock).get('Authorization')).toBe('Bearer oauth-token')
  })

  it('preserves Headers inputs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: true }))

    await planeFetch(planeClient(), '/api/v1/users/me/', {
      headers: new Headers([['X-Custom', 'from-headers']])
    })

    expect(fetchHeaders(fetchMock).get('X-Custom')).toBe('from-headers')
  })

  it('preserves tuple header inputs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ok: true }))

    await planeFetch(planeClient(), '/api/v1/users/me/', { headers: [['X-Custom', 'from-tuples']] })

    expect(fetchHeaders(fetchMock).get('X-Custom')).toBe('from-tuples')
  })

  it('refreshes expired OAuth tokens before the API request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 })
      )
      .mockResolvedValueOnce(response({ ok: true }))
    const client: PlaneClientForInstance = {
      instance: {
        id: 'plane-oauth',
        baseUrl: 'https://plane.example',
        workspaceSlug: 'acme',
        displayName: 'Acme',
        authMode: 'oauth'
      },
      auth: {
        kind: 'oauth',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1,
        clientId: 'client-id',
        clientSecret: 'client-secret'
      }
    }

    await planeFetch(client, '/api/v1/users/me/')

    expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe('https://plane.example/auth/o/token/')
    expect(fetchHeaders(fetchMock, 1).get('Authorization')).toBe('Bearer fresh-token')
    expect(writeTokenMock).toHaveBeenCalledWith(
      'plane-oauth',
      expect.stringContaining('fresh-token')
    )
  })
})

function planeClient(): PlaneClientForInstance {
  return {
    instance: {
      id: 'plane-1',
      baseUrl: 'https://plane.example',
      workspaceSlug: 'acme',
      displayName: 'Acme'
    },
    auth: { kind: 'apiKey', apiKey: 'pat-token' }
  }
}
