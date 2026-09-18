import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_FETCH = globalThis.fetch
const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(
  () => ({
    closeAllConnectionsMock: vi.fn(),
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn()
  })
)

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

type MantisBTSiteFixture = {
  siteUrl?: string
  userId?: string
  displayName?: string
}

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function tokenPathForSite(siteId: string): string {
  return join(
    tempHome,
    '.orca',
    'mantisBT-tokens',
    `${Buffer.from(siteId).toString('base64url')}.enc`
  )
}

function writeMantisBTFiles(
  siteId: string,
  token: string | Buffer,
  fixture: MantisBTSiteFixture = {}
): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'mantisBT-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'mantisBT-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: fixture.siteUrl ?? 'https://mantisbt.example.com',
            userId: fixture.userId ?? '42',
            displayName: fixture.displayName ?? 'William'
          }
        ]
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  )
  writeFileSync(tokenPathForSite(siteId), token)
}

function writeMultiSiteFiles(
  sites: { id: string; token: string | Buffer }[],
  selectedSiteId: string
): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'mantisBT-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'mantisBT-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: sites[0]?.id ?? null,
        selectedSiteId,
        sites: sites.map((site) => ({
          id: site.id,
          siteUrl: `https://${site.id}.example.com`,
          userId: `user-${site.id}`,
          displayName: site.id
        }))
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  )
  for (const site of sites) {
    writeFileSync(tokenPathForSite(site.id), site.token)
  }
}

async function loadClientModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  // Why here and not in beforeEach: vi.resetModules() above gives the http-client module
  // a fresh singleton, so the port must be installed on that instance.
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements only resolveProxy/setProxy, the two proxySession operations mantisBTFetch calls.
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => options.encryptionAvailable ?? false,
    encryptString: (value) => Buffer.from(value),
    decryptString: options.decryptString ?? ((value) => value.toString('utf-8')),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  // One import call per reset so the split modules share a single graph (and
  // thus one copy of the request queue / credential caches) per test.
  const [client, queue, api] = await Promise.all([
    import('./client'),
    import('./request-queue'),
    import('./authenticated-request')
  ])
  return { ...client, ...queue, ...api }
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-mantisBT-client-')
  fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts routes every call through httpClient.fetch (netFetchMock); this stub only guards against an accidental fallback to the raw global.
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('MantisBT client credential storage', () => {
  it('connects successfully and persists the site and token', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { id: 42, name: 'wquintal', real_name: 'William', email: 'william@example.com' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    await expect(
      mantisBT.connect({ siteUrl: 'mantisbt.example.com', apiToken: 'token-alpha' })
    ).resolves.toMatchObject({
      ok: true,
      viewer: { id: '42', displayName: 'William', email: 'william@example.com' }
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://mantisbt.example.com/api/rest/users/me',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts always constructs RequestInit.headers as a Headers instance before calling fetch.
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-alpha')
    expect(headers.get('User-Agent')).toBe('Orca')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is exactly the shape writeSiteFile serializes; the assertions below verify the actual field values.
    const stored = JSON.parse(
      readFileSync(join(tempHome, '.orca', 'mantisBT-sites.json'), 'utf-8')
    ) as {
      sites: { id: string; userId: string; displayName: string }[]
    }
    expect(stored.sites).toHaveLength(1)
    expect(stored.sites[0]).toMatchObject({ userId: '42', displayName: 'William' })
    const storedSiteId = stored.sites[0]?.id
    expect(storedSiteId).toBeTruthy()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by the `toBeTruthy()` assertion on the previous line.
    expect(existsSync(tokenPathForSite(storedSiteId as string))).toBe(true)
  })

  it('reports a connection failure for an invalid token', async () => {
    const unauthorized = () =>
      new Response(JSON.stringify({ message: 'Access denied' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' }
      })
    // A genuinely bad token fails every auth-scheme/path-style combo the
    // connect probe tries, so all four must be queued.
    netFetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized())
    const mantisBT = await loadClientModule()

    await expect(
      mantisBT.connect({ siteUrl: 'mantisbt.example.com', apiToken: 'bad-token' })
    ).resolves.toEqual({ ok: false, error: 'Access denied' })

    expect(netFetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mantisBT.getStatus()).toMatchObject({ connected: false })
  })

  it('requires an API token to connect', async () => {
    const mantisBT = await loadClientModule()

    await expect(
      mantisBT.connect({ siteUrl: 'mantisbt.example.com', apiToken: '  ' })
    ).resolves.toEqual({ ok: false, error: 'API token is required.' })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reflects persisted sites in getStatus', async () => {
    const siteId = 'site-alpha'
    writeMantisBTFiles(siteId, 'token-alpha')
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    expect(mantisBT.getStatus()).toMatchObject({
      connected: true,
      activeSiteId: siteId,
      selectedSiteId: siteId,
      sites: [{ id: siteId, displayName: 'William' }],
      viewer: { id: '42', displayName: 'William' }
    })
  })

  it('removes a site token and site-file entry on disconnect', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeMantisBTFiles(siteId, 'token-alpha')
    const mantisBT = await loadClientModule({ encryptionAvailable: true })
    expect(mantisBT.getStatus().connected).toBe(true)

    mantisBT.disconnect(siteId)

    expect(existsSync(tokenPath)).toBe(false)
    expect(mantisBT.getStatus()).toMatchObject({ connected: false, sites: [] })
  })

  it('supports selectSite and getClients across multiple connected sites', async () => {
    writeMultiSiteFiles(
      [
        { id: 'alpha', token: 'token-alpha' },
        { id: 'beta', token: 'token-beta' }
      ],
      'alpha'
    )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    expect(
      mantisBT
        .getClients('all')
        .map((client) => client.site.id)
        .sort()
    ).toEqual(['alpha', 'beta'])
    expect(mantisBT.getClients('beta').map((client) => client.site.id)).toEqual(['beta'])

    const status = mantisBT.selectSite('beta')
    expect(status.selectedSiteId).toBe('beta')
    expect(status.activeSiteId).toBe('beta')
    expect(mantisBT.getClients().map((client) => client.site.id)).toEqual(['beta'])
  })

  it('clears the token and removes the site on clearToken', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeMantisBTFiles(siteId, 'token-alpha')
    const mantisBT = await loadClientModule({ encryptionAvailable: true })
    expect(mantisBT.getStatus().connected).toBe(true)

    mantisBT.clearToken(siteId)

    expect(existsSync(tokenPath)).toBe(false)
    expect(mantisBT.getStatus()).toMatchObject({ connected: false, sites: [] })
  })

  it('classifies only 401 responses as auth errors', async () => {
    const mantisBT = await loadClientModule()

    expect(mantisBT.isAuthError(new mantisBT.MantisBTApiError('Unauthorized', 401))).toBe(true)
    expect(mantisBT.isAuthError(new mantisBT.MantisBTApiError('Forbidden', 403))).toBe(false)
    expect(mantisBT.isAuthError(new Error('boom'))).toBe(false)
  })

  it('does not pass encrypted safeStorage bytes to MantisBT when encryption is unavailable', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeMantisBTFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const mantisBT = await loadClientModule({ encryptionAvailable: false })

    await expect(mantisBT.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved MantisBT credential. Approve Keychain access or reconnect MantisBT.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(mantisBT.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved MantisBT credential. Approve Keychain access or reconnect MantisBT.',
      sites: [{ id: siteId }]
    })
  })

  it('bridges proxy environment settings before MantisBT connect requests', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 7, name: 'ada', real_name: 'Ada' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const mantisBT = await loadClientModule()

    await expect(
      mantisBT.connect({ siteUrl: 'mantisbt.example.com', apiToken: 'token-alpha' })
    ).resolves.toMatchObject({ ok: true, viewer: { displayName: 'Ada' } })

    expect(resolveProxyMock).toHaveBeenCalledWith('https://mantisbt.example.com/api/rest/users/me')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('evicts the token when testConnection receives a 401', async () => {
    const siteId = 'site-alpha'
    writeMantisBTFiles(siteId, 'token-alpha')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Access denied' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    await expect(mantisBT.testConnection(siteId)).resolves.toMatchObject({ ok: false })

    expect(existsSync(tokenPathForSite(siteId))).toBe(false)
    expect(mantisBT.getStatus()).toMatchObject({ connected: false, sites: [] })
  })

  it('propagates a real deletion failure from disconnect instead of reporting success', async () => {
    const siteId = 'site-alpha'
    writeMantisBTFiles(siteId, 'token-alpha')
    const tokenPath = tokenPathForSite(siteId)
    // Replace the token file with a directory so unlinkSync fails with
    // EISDIR — a real non-ENOENT deletion failure, distinct from "already
    // gone", that must not be swallowed as a successful disconnect.
    unlinkSync(tokenPath)
    mkdirSync(tokenPath)
    const mantisBT = await loadClientModule({ encryptionAvailable: true })
    expect(mantisBT.getStatus().connected).toBe(true)

    expect(() => mantisBT.disconnect(siteId)).toThrow()

    // Deletion genuinely failed — the directory is still there, and the
    // site is not silently reported as disconnected.
    expect(existsSync(tokenPath)).toBe(true)
  })

  it('surfaces the HTTPS-required error message when connecting over plain HTTP', async () => {
    const mantisBT = await loadClientModule()

    await expect(
      mantisBT.connect({ siteUrl: 'http://mantisbt.example.com', apiToken: 'token-alpha' })
    ).resolves.toEqual({
      ok: false,
      error: 'Enter an HTTPS MantisBT site URL (HTTP is only allowed for localhost).'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('falls back through legacy auth scheme and index.php path for a pre-2.29 self-hosted server', async () => {
    // Reproduces a real deployment: modern Bearer scheme 401s (server
    // predates 2.29.0's RFC 6750 support), the Bearer+index.php combo 404s
    // (still the wrong auth scheme), legacy scheme without index.php 401s
    // (URL rewriting isn't configured), and only legacy+index.php succeeds.
    const unauthorized = () =>
      new Response(JSON.stringify({ message: 'Access denied' }), { status: 401 })
    const notFound = () => new Response('Not Found', { status: 404 })
    netFetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: 34, name: 'anson', real_name: 'Anson' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    await expect(
      mantisBT.connect({ siteUrl: 'mantisbt.example.com', apiToken: 'legacy-token' })
    ).resolves.toMatchObject({ ok: true, viewer: { displayName: 'Anson' } })

    expect(netFetchMock).toHaveBeenCalledTimes(4)
    const urls = netFetchMock.mock.calls.map((call) => call[0])
    expect(urls).toEqual([
      'https://mantisbt.example.com/api/rest/users/me',
      'https://mantisbt.example.com/api/rest/index.php/users/me',
      'https://mantisbt.example.com/api/rest/users/me',
      'https://mantisbt.example.com/api/rest/index.php/users/me'
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts always constructs RequestInit.headers as a Headers instance before calling fetch.
    const lastHeaders = netFetchMock.mock.calls[3]?.[1]?.headers as Headers
    expect(lastHeaders.get('Authorization')).toBe('legacy-token')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is exactly the shape writeSiteFile serializes; the assertion below verifies the negotiated combo was persisted.
    const stored = JSON.parse(
      readFileSync(join(tempHome, '.orca', 'mantisBT-sites.json'), 'utf-8')
    ) as { sites: { authScheme: string; usePhpIndexPath: boolean }[] }
    expect(stored.sites[0]).toMatchObject({ authScheme: 'legacy', usePhpIndexPath: true })
  })

  it('reuses the persisted auth scheme and path style without re-probing', async () => {
    const siteId = 'site-legacy'
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'mantisBT-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'mantisBT-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: 'https://mantisbt.example.com',
            userId: '34',
            displayName: 'Anson',
            authScheme: 'legacy',
            usePhpIndexPath: true
          }
        ]
      })
    )
    writeFileSync(tokenPathForSite(siteId), 'legacy-token')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 34, name: 'anson', real_name: 'Anson' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    await expect(mantisBT.testConnection(siteId)).resolves.toMatchObject({ ok: true })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://mantisbt.example.com/api/rest/index.php/users/me',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts always constructs RequestInit.headers as a Headers instance before calling fetch.
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('legacy-token')
  })

  it('defaults a site file saved before scheme/path negotiation existed to Bearer and the pretty REST path', async () => {
    const siteId = 'site-alpha'
    // writeMantisBTFiles intentionally omits authScheme/usePhpIndexPath to
    // model a site file persisted before this negotiation existed.
    writeMantisBTFiles(siteId, 'token-alpha')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 42, name: 'wquintal', real_name: 'William' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const mantisBT = await loadClientModule({ encryptionAvailable: true })

    await expect(mantisBT.testConnection(siteId)).resolves.toMatchObject({ ok: true })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://mantisbt.example.com/api/rest/users/me',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts always constructs RequestInit.headers as a Headers instance before calling fetch.
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-alpha')
  })
})
