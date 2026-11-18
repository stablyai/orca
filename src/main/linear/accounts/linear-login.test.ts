import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''
const created: unknown[] = []

async function load() {
  vi.resetModules()
  const { setSecretStore } = await import('../../../shared/secure-storage/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => value.toString('utf-8').replace(/^sealed:/, ''),
    describeProtectionGap: () => null
  })
  vi.doMock('os', () => ({ ...realOs, homedir: () => tempHome }))
  vi.doMock('../requests/linear-sdk', () => ({
    createLinearClient: (options: unknown) => {
      created.push(options)
      return {}
    },
    loadLinearSdk: () => ({ AuthenticationLinearError: class extends Error {} })
  }))
  return {
    client: await import('./linear-account-client'),
    store: await import('./linear-login-store'),
    tokens: await import('./linear-token-store'),
    refresh: await import('./linear-login-refresh'),
    paths: await import('./linear-credential-paths')
  }
}

const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000
const login = (expiresAt: number, suffix = '1') => ({
  accessToken: `lin_oauth_access_${suffix}`,
  refreshToken: `lin_refresh_${suffix}`,
  expiresAt,
  clientId: 'client-1'
})
const linked = {
  identity: { userId: 'user-ada', name: 'Ada Lovelace', handle: 'ada', email: 'ada@acme.dev' },
  workspace: { id: 'org-acme', name: 'Acme', urlKey: 'acme' }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(realOs.tmpdir(), 'orca-linear-login-'))
  created.length = 0
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Connect Linear’s login on this Mac', () => {
  it('adds the workspace it signed in to and calls Linear as the person with it', async () => {
    const { client, store } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    expect(client.getStatus()).toMatchObject({
      connected: true,
      workspaces: [{ id: 'org-acme', organizationName: 'Acme', displayName: 'ada' }]
    })
    expect(client.getClients('org-acme')[0]?.credential).toEqual({
      accessToken: 'lin_oauth_access_1',
      reauthorize: expect.any(Function)
    })
    expect(created.at(-1)).toEqual({
      accessToken: 'lin_oauth_access_1',
      reauthorize: expect.any(Function)
    })
  })

  it('leaves the active workspace where it was', async () => {
    const { client, store } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), {
      ...linked,
      workspace: { id: 'org-beta', name: 'Beta', urlKey: 'beta' }
    })
    expect(client.getStatus().activeWorkspaceId).toBe('org-acme')
  })

  it('uses a saved API key before the login', async () => {
    const { client, store, paths } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    const { saveWorkspaceToken } = await import('./linear-token-store')
    saveWorkspaceToken('org-acme', 'lin_api_key')
    expect(client.getClients('org-acme')[0]?.credential).toEqual({ apiKey: 'lin_api_key' })
    // Disconnecting the workspace forgets both.
    client.disconnect('org-acme')
    expect(existsSync(paths.getWorkspaceLoginPath('org-acme'))).toBe(false)
    expect(client.getStatus().connected).toBe(false)
  })

  it('stores the login encrypted, never as plain text', async () => {
    const { store, paths } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(paths.getWorkspaceLoginPath('org-acme'), 'utf-8')).toMatch(/^sealed:/)
  })
})

describe('Refreshing the login', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status })
    )

  it('refreshes a login near its end with the client id alone, and saves the rotated pair', async () => {
    const { store, refresh } = await load()
    store.keepConnectedLinearLogin(login(NOW + HOUR / 2), linked)
    const request = answer(200, {
      access_token: 'lin_oauth_access_2',
      refresh_token: 'lin_refresh_2',
      expires_in: 86_399
    })
    await Promise.all([
      refresh.refreshLinearLogin('org-acme', { now: () => NOW, request }),
      refresh.refreshLinearLogin('org-acme', { now: () => NOW, request })
    ])
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0] ?? []
    expect(url).toBe('https://api.linear.app/oauth/token')
    expect(init?.headers).not.toHaveProperty('authorization')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'lin_refresh_1',
      client_id: 'client-1'
    })
    expect(store.readWorkspaceLogin('org-acme')).toEqual({
      ...login(NOW + 86_399_000, '2')
    })
  })

  it('leaves a login with hours left alone', async () => {
    const { store, refresh } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    const request = answer(200, {})
    await refresh.refreshDueLinearLogins({ now: () => NOW, request })
    expect(request).not.toHaveBeenCalled()
  })

  it('forgets a login Linear refuses for good, so Orca says to connect again', async () => {
    const { client, store, refresh } = await load()
    store.keepConnectedLinearLogin(login(NOW - HOUR), linked)
    await refresh.refreshDueLinearLogins({
      now: () => NOW,
      request: answer(400, { error: 'invalid_grant' })
    })
    expect(store.readWorkspaceLogin('org-acme')).toBeNull()
    expect(client.getStatus().connected).toBe(false)
  })

  it('keeps the login when Linear can’t be reached or answers oddly', async () => {
    const { store, refresh } = await load()
    store.keepConnectedLinearLogin(login(NOW - HOUR), linked)
    await refresh.refreshLinearLogin('org-acme', {
      now: () => NOW,
      request: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    await refresh.refreshLinearLogin('org-acme', {
      now: () => NOW,
      request: answer(500, { error: 'server_error' })
    })
    expect(store.readWorkspaceLogin('org-acme')).toEqual(login(NOW - HOUR))
  })

  it('stops counting as signed in once the last login or key for a workspace is gone', async () => {
    const { client, store, tokens } = await load()
    store.keepConnectedLinearLogin(login(NOW + 20 * HOUR), linked)
    tokens.saveWorkspaceToken('org-acme', 'lin_api_1')
    // A refresh Linear refused (invalid_grant) drops the login; the API key still signs in.
    store.clearWorkspaceLogin('org-acme')
    expect(client.getStatus().connected).toBe(true)
    // With the key file gone too, the registered workspace no longer counts.
    tokens.clearTokenFile('org-acme')
    expect(client.getStatus()).toMatchObject({ connected: false, workspaces: [] })
  })
})
