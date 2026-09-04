import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore } from '../../shared/secret-store'

const OLD_FETCH = globalThis.fetch
const { netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function tokenPathFor(workspaceId: string): string {
  return join(
    tempHome,
    '.orca',
    'plane-tokens',
    `${Buffer.from(workspaceId).toString('base64url')}.enc`
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

async function loadPlaneModules() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf-8')
    },
    session: {
      defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock }
    }
  }))
  // Both specifiers are mocked deliberately: the credential store imports
  // `node:os`, and relying on one specifier resolving to the other would put
  // real credentials under the developer's home directory if that ever changed.
  const osMock = async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  }
  vi.doMock('os', osMock)
  vi.doMock('node:os', osMock)
  // One import call per reset so the split modules share a single graph, and
  // therefore one copy of the credential caches and request queue, per test.
  const [client, store, api] = await Promise.all([
    import('./client'),
    import('./workspace-credential-store'),
    import('./authenticated-request')
  ])
  return { ...client, ...store, ...api }
}

const workspaceFixture = {
  id: 'ws-1',
  slug: 'acme',
  name: 'acme',
  baseUrl: 'https://api.plane.so',
  appUrl: 'https://app.plane.so',
  deployment: 'cloud' as const
}

const CONNECT_ARGS = {
  baseUrl: 'https://api.plane.so',
  workspaceSlug: 'acme',
  apiToken: 'plane_api_secret'
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-plane-client-'))
  fetchMock = vi.fn(async () => {
    throw new Error('global fetch must not be used; Plane goes through net.fetch')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('connect', () => {
  it('verifies the token, then verifies the slug, and stores the credential', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'u-1', display_name: 'Ada' }))
      .mockResolvedValueOnce(jsonResponse({ results: [], next_page_results: false }))

    const plane = await loadPlaneModules()
    const result = await plane.connect(CONNECT_ARGS)

    expect(result).toMatchObject({ ok: true, viewer: { id: 'u-1', displayName: 'Ada' } })
    expect(netFetchMock.mock.calls[0]?.[0]).toBe('https://api.plane.so/api/v1/users/me/')
    // /users/me/ only proves the token; Plane has no workspace-list endpoint,
    // so a scoped read is the only way to catch a mistyped slug at connect time.
    expect(netFetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.plane.so/api/v1/workspaces/acme/projects/?per_page=1'
    )
    expect(fetchMock).not.toHaveBeenCalled()

    const workspaceId = result.ok ? result.workspace.id : ''
    // Why: the token is written through the app secret store, so the file
    // holds ciphertext; decrypting through the same store proves the round trip.
    expect(getSecretStore().decryptString(readFileSync(tokenPathFor(workspaceId)))).toBe(
      'plane_api_secret'
    )
  })

  it('sends the token as X-API-Key with a non-browser user agent', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'u-1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const plane = await loadPlaneModules()
    await plane.connect(CONNECT_ARGS)

    const headers = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-api-key')).toBe('plane_api_secret')
    expect(headers.get('user-agent')).toBe('Orca')
    expect(headers.get('authorization')).toBeNull()
  })

  it('explains a rejected token without leaking the raw status', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid API key' }, 401))
    const plane = await loadPlaneModules()
    await expect(plane.connect(CONNECT_ARGS)).resolves.toEqual({
      ok: false,
      error:
        'Plane rejected the API token. Regenerate it in Plane under Profile settings → Personal access tokens.'
    })
  })

  it('names the workspace slug when only the scoped read fails', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'u-1' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Not found' }, 404))
    const plane = await loadPlaneModules()
    await expect(plane.connect(CONNECT_ARGS)).resolves.toEqual({
      ok: false,
      error: 'Workspace "acme" is not reachable with this token. Check the slug in your Plane URL.'
    })
  })

  it('requires both a slug and a token before touching the network', async () => {
    const plane = await loadPlaneModules()
    await expect(plane.connect({ ...CONNECT_ARGS, workspaceSlug: '  ' })).resolves.toEqual({
      ok: false,
      error: 'Workspace slug and API token are required.'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})

describe('status and selection', () => {
  async function connected() {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'u-1', display_name: 'Ada' }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const plane = await loadPlaneModules()
    const result = await plane.connect(CONNECT_ARGS)
    return { plane, workspaceId: result.ok ? result.workspace.id : '' }
  }

  it('reports the connected workspace as active and selected', async () => {
    const { plane, workspaceId } = await connected()
    expect(plane.getStatus()).toMatchObject({
      connected: true,
      activeWorkspaceId: workspaceId,
      selectedWorkspaceId: workspaceId
    })
    expect(plane.getStatus().workspaces?.[0]).toMatchObject({ slug: 'acme', deployment: 'cloud' })
  })

  it('keeps the active workspace when the selection widens to all', async () => {
    const { plane, workspaceId } = await connected()
    expect(plane.selectWorkspace('all')).toMatchObject({
      selectedWorkspaceId: 'all',
      activeWorkspaceId: workspaceId
    })
  })

  it('ignores a selection that names no stored workspace', async () => {
    const { plane, workspaceId } = await connected()
    expect(plane.selectWorkspace('ws-unknown')).toMatchObject({
      selectedWorkspaceId: workspaceId
    })
  })

  it('hands a client the stored token for the selected workspace', async () => {
    const { plane, workspaceId } = await connected()
    const clients = plane.getClients()
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ apiToken: 'plane_api_secret' })
    expect(clients[0]?.workspace.id).toBe(workspaceId)
  })

  it('disconnect removes the credential and the workspace record', async () => {
    const { plane, workspaceId } = await connected()
    plane.disconnect()
    expect(existsSync(tokenPathFor(workspaceId))).toBe(false)
    expect(plane.getStatus()).toMatchObject({ connected: false, workspaces: [] })
    expect(plane.getClients()).toEqual([])
  })

  it('reports no connection before anything is stored', async () => {
    const plane = await loadPlaneModules()
    expect(plane.getStatus()).toMatchObject({ connected: false, viewer: null })
  })
})

describe('testConnection', () => {
  it('explains that nothing is connected rather than throwing', async () => {
    const plane = await loadPlaneModules()
    await expect(plane.testConnection()).resolves.toEqual({
      ok: false,
      error: 'Not connected to Plane.'
    })
  })
})

describe('isPlaneAuthError', () => {
  it('treats only 401 as a bad credential, since 403 is a permission gap', async () => {
    const plane = await loadPlaneModules()
    expect(plane.isPlaneAuthError(new plane.PlaneApiError('nope', 401))).toBe(true)
    expect(plane.isPlaneAuthError(new plane.PlaneApiError('forbidden', 403))).toBe(false)
    expect(plane.isPlaneAuthError(new Error('unrelated'))).toBe(false)
  })
})

describe('rate limit admission', () => {
  it('holds a queued burst when an earlier response exhausts the budget', async () => {
    // Regression: the budget was checked before queueing, so requests already
    // waiting on the pool were released straight into net.fetch after an
    // earlier response reported the allowance spent.
    let released = 0
    netFetchMock.mockImplementation(async () => {
      released += 1
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30)
        }
      })
    })

    const plane = await loadPlaneModules()
    const client = { workspace: { ...workspaceFixture }, apiToken: 'plane_api_secret' }
    const first = plane.planeRequest(client, 'workspaces/acme/projects/')
    await first
    expect(released).toBe(1)

    // The budget is now parked; a follow-up must not reach the network.
    const second = plane.planeRequest(client, 'workspaces/acme/projects/')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(released).toBe(1)
    void second.catch(() => undefined)
  })
})
