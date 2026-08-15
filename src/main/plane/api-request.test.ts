import { afterEach, describe, expect, it, vi } from 'vitest'
import { planeFetch } from './api-request'
import type { PlaneClientForInstance } from './client'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('Plane API requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'X-API-Key': 'pat-token' })
    })
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
      auth: { kind: 'oauth', accessToken: 'oauth-token' }
    }

    await planeFetch(client, '/api/v1/users/me/')

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer oauth-token' })
    })
  })
})
