import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GiteaServerFile } from './server-store'

const { store } = vi.hoisted(() => ({
  store: {
    file: {
      version: 1,
      activeServerId: null,
      selectedServerId: null,
      servers: []
    } as GiteaServerFile,
    tokens: new Map<string, string>()
  }
}))

vi.mock('./server-store', () => ({
  normalizeGiteaApiBaseUrl: (value: string): string => {
    const trimmed = value.trim().replace(/\/+$/, '')
    return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
  },
  deriveGiteaWebBaseUrl: (apiBaseUrl: string): string => apiBaseUrl.replace(/\/api\/v1$/i, ''),
  getGiteaServerId: (apiBaseUrl: string): string => `id:${apiBaseUrl}`,
  getServerFile: (): GiteaServerFile => store.file,
  writeServerFile: (file: GiteaServerFile): void => {
    store.file = file
  },
  saveToken: (serverId: string, token: string): void => {
    store.tokens.set(serverId, token)
  },
  deleteToken: (serverId: string): void => {
    store.tokens.delete(serverId)
  },
  hasStoredToken: (serverId: string): boolean => store.tokens.has(serverId),
  getCredentialError: (): string | undefined => undefined,
  getServerTokens: (selection?: string | null) => {
    const selected = selection ?? store.file.selectedServerId ?? store.file.activeServerId
    const servers =
      selected === 'all'
        ? store.file.servers
        : store.file.servers.filter((server) => server.id === selected)
    return servers.flatMap((server) => {
      const token = store.tokens.get(server.id)
      return token ? [{ server, token }] : []
    })
  }
}))

import { connect, disconnect, getStatus, selectServer, testConnection } from './connect'

function resetStore(): void {
  store.file = { version: 1, activeServerId: null, selectedServerId: null, servers: [] }
  store.tokens.clear()
}

describe('gitea connect', () => {
  beforeEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  it('connects, validates the token, and stores the server as active', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://git.example.com/api/v1/user')
      expect(new Headers(init?.headers).get('Authorization')).toBe('token secret')
      return Response.json({ login: 'octo', full_name: 'Octo Cat' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await connect({ baseUrl: 'https://git.example.com', token: 'secret' })

    expect(result).toEqual({ ok: true, viewer: { login: 'octo', fullName: 'Octo Cat' } })
    const id = 'id:https://git.example.com/api/v1'
    expect(store.tokens.get(id)).toBe('secret')
    expect(store.file.activeServerId).toBe(id)
    expect(store.file.servers[0]).toMatchObject({
      id,
      apiBaseUrl: 'https://git.example.com/api/v1',
      baseUrl: 'https://git.example.com',
      account: 'octo'
    })
  })

  it('rejects an empty server URL before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(connect({ baseUrl: '', token: 'secret' })).resolves.toEqual({
      ok: false,
      error: 'Enter a valid Gitea server URL.'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires an access token', async () => {
    await expect(connect({ baseUrl: 'https://git.example.com', token: '  ' })).resolves.toEqual({
      ok: false,
      error: 'An access token is required.'
    })
  })

  it('surfaces a rejected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    )
    const result = await connect({ baseUrl: 'https://git.example.com', token: 'bad' })
    expect(result.ok).toBe(false)
  })

  it('accepts a valid token that lacks the read:user scope (403)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: 'token does not have at least one of required scope(s): [read:user]'
            }),
            { status: 403 }
          )
      )
    )
    const result = await connect({ baseUrl: 'https://git.example.com', token: 'scoped' })
    expect(result.ok).toBe(true)
    const id = 'id:https://git.example.com/api/v1'
    expect(store.file.activeServerId).toBe(id)
    expect(store.file.servers[0]?.account).toBeNull()
  })

  it('reports connection status from stored servers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ login: 'octo' }))
    )
    await connect({ baseUrl: 'https://git.example.com', token: 'secret' })

    const status = getStatus()
    expect(status.connected).toBe(true)
    expect(status.servers).toHaveLength(1)
    expect(status.activeServerId).toBe('id:https://git.example.com/api/v1')
  })

  it('disconnects a server and clears its token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ login: 'octo' }))
    )
    await connect({ baseUrl: 'https://git.example.com', token: 'secret' })
    const id = 'id:https://git.example.com/api/v1'

    disconnect(id)

    expect(store.tokens.has(id)).toBe(false)
    expect(getStatus().connected).toBe(false)
  })

  it('selects all servers for fan-out reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ login: 'octo' }))
    )
    await connect({ baseUrl: 'https://git.example.com', token: 'secret' })

    expect(selectServer('all').selectedServerId).toBe('all')
  })

  it('tests a stored connection against the live server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ login: 'octo' }))
    )
    await connect({ baseUrl: 'https://git.example.com', token: 'secret' })

    await expect(testConnection()).resolves.toEqual({
      ok: true,
      viewer: { login: 'octo', fullName: null }
    })
  })
})
