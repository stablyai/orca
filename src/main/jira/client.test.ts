import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function tokenPathForSite(siteId: string): string {
  return join(tempHome, '.orca', 'jira-tokens', `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function writeJiraFiles(siteId: string, token: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'jira-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: 'https://example.atlassian.net',
            email: 'ada@example.com',
            displayName: 'Ada',
            accountId: 'account-alpha'
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
  mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'jira-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: sites[0]?.id ?? null,
        selectedSiteId,
        sites: sites.map((site) => ({
          id: site.id,
          siteUrl: `https://${site.id}.atlassian.net`,
          email: `${site.id}@example.com`,
          displayName: site.id,
          accountId: `account-${site.id}`
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
    safeStorage: {
      isEncryptionAvailable: () => options.encryptionAvailable ?? false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: options.decryptString ?? ((value: Buffer) => value.toString('utf-8'))
    },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  return import('./client')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-jira-client-')
  fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Jira client credential storage', () => {
  it('preserves plaintext fallback and reaches Jira auth header construction', async () => {
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, 'token-alpha')
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accountId: 'account-alpha',
          displayName: 'Ada',
          emailAddress: 'ada@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('not encrypted')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada' }
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(resolveProxyMock).toHaveBeenCalledWith('https://example.atlassian.net/rest/api/3/myself')
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://example.atlassian.net/rest/api/3/myself',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada@example.com:token-alpha').toString('base64')}`
    )
  })

  it('sends a non-browser User-Agent on Jira POST requests', async () => {
    // Why: Electron's net.fetch defaults to a Chrome User-Agent, which trips
    // Atlassian's XSRF filter on POST/PUT REST calls (issue search, create,
    // update, comment) even under API-token auth, surfacing as a 403.
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, 'token-alpha')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule({ encryptionAvailable: true })
    const client = jira.getClients(siteId)[0]

    if (!client) {
      throw new Error('Expected stored Jira client')
    }

    await jira.jiraRequest(client, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql: 'project = ALP' })
    })

    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    const userAgent = headers.get('User-Agent') ?? ''
    expect(netFetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(userAgent).toBe('Orca')
    expect(userAgent).not.toMatch(/Mozilla|Chrome|Safari|AppleWebKit/i)
  })

  it('does not pass encrypted safeStorage bytes to Jira when encryption is unavailable', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const jira = await loadClientModule({ encryptionAvailable: false })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.',
      sites: [{ id: siteId }]
    })
  })

  it('does not clear the Jira token when safeStorage decryption fails', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.',
      sites: [{ id: siteId }]
    })
  })

  it('does not clear plaintext fallback credentials on Jira auth failure after decrypt failure', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, 'token-revoked')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorMessages: ['Jira authentication failed'] }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Jira authentication failed'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      sites: [{ id: siteId }]
    })
  })

  it('clears the recorded credential error after Keychain access is approved', async () => {
    const siteId = 'site-alpha'
    let keychainApproved = false
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accountId: 'account-alpha',
          displayName: 'Ada',
          emailAddress: 'ada@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        if (!keychainApproved) {
          throw new Error('userCanceledErr')
        }
        return 'token-alpha'
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({ ok: false })
    expect(jira.getStatus().credentialError).toContain('Could not decrypt')

    keychainApproved = true
    await expect(jira.testConnection(siteId)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jira.getStatus().credentialError).toBeUndefined()
  })

  it('treats empty Jira token files as missing credentials', async () => {
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, Buffer.alloc(0))
    const jira = await loadClientModule({ encryptionAvailable: false })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Not connected to Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(jira.getStatus()).toMatchObject({ connected: false })
  })

  it('keeps healthy sites under the "all" selection when one site cannot be decrypted', async () => {
    writeMultiSiteFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'all'
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      // Why: only the binary "bad" token throws on decrypt; the plaintext
      // "good" token falls back through the legacy path.
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    const clients = jira.getClients('all')
    expect(clients.map((client) => client.site.id)).toEqual(['good'])
    // The bad site's decrypt error is still recorded for the status banner.
    expect(jira.getStatus().credentialError).toContain('Could not decrypt')
  })

  it('rethrows the decrypt error for a specific site selection', async () => {
    writeMultiSiteFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'bad'
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    expect(() => jira.getClients('bad')).toThrow('Could not decrypt')
  })

  it('does not clear credentials when Electron transport fails after a network change', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, 'token-alpha')
    netFetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: new Error('socket disconnected')
      })
    )
    const jira = await loadClientModule()

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'fetch failed'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      sites: [{ id: siteId }]
    })
  })

  it('does not treat Jira permission failures as credential revocation', async () => {
    const jira = await loadClientModule()

    expect(jira.isAuthError(new jira.JiraApiError('Unauthorized', 401))).toBe(true)
    expect(jira.isAuthError(new jira.JiraApiError('Forbidden', 403))).toBe(false)
  })

  it('connects to self-hosted Jira with a Bearer PAT against REST v2', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: 'wquintal',
          key: 'JIRAUSER10101',
          displayName: 'William',
          emailAddress: 'william@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'jira.example.com',
        email: '',
        apiToken: 'pat-token',
        authType: 'server'
      })
    ).resolves.toMatchObject({
      ok: true,
      // Server /myself has no accountId; the username stands in for it.
      viewer: { displayName: 'William', accountId: 'wquintal' }
    })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/2/myself',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer pat-token')
  })

  it('connects to self-hosted Jira with Basic username/password against REST v2', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ name: 'jdoe', key: 'JIRAUSER20202', displayName: 'Jane Doe' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'jira.example.com',
        // A username present means classic Basic auth (older Server/DC that
        // predate PATs); the token slot carries the account password.
        email: 'jdoe',
        apiToken: 'account-password',
        authType: 'server'
      })
    ).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Jane Doe', accountId: 'jdoe' }
    })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/2/myself',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('jdoe:account-password').toString('base64')}`
    )
  })

  it('uses Basic auth for stored self-hosted sites that carry a username', async () => {
    const siteId = 'site-server-basic'
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: 'https://jira.example.com',
            email: 'jdoe',
            displayName: 'Jane Doe',
            accountId: 'jdoe',
            authType: 'server'
          }
        ]
      }),
      { encoding: 'utf-8' }
    )
    writeFileSync(tokenPathForSite(siteId), 'account-password')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'jdoe', displayName: 'Jane Doe' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule()

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({ ok: true })

    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('jdoe:account-password').toString('base64')}`
    )
  })

  it('requires a token but not an email for self-hosted connections', async () => {
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'jira.example.com',
        email: '',
        apiToken: '',
        authType: 'server'
      })
    ).resolves.toEqual({ ok: false, error: 'Personal access token is required.' })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('requires a password when a username is present on self-hosted', async () => {
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'jira.example.com',
        email: 'jdoe',
        apiToken: '',
        authType: 'server'
      })
    ).resolves.toEqual({ ok: false, error: 'Password is required.' })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('keeps distinct self-hosted PAT accounts on one host as separate sites', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'alice', displayName: 'Alice' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'bot', displayName: 'Bot' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const jira = await loadClientModule()

    await jira.connect({
      siteUrl: 'jira.example.com',
      email: '',
      apiToken: 'alice-pat',
      authType: 'server'
    })
    await jira.connect({
      siteUrl: 'jira.example.com',
      email: '',
      apiToken: 'bot-pat',
      authType: 'server'
    })

    // Two PATs (both with empty email) to the same host must not collide onto
    // one id and silently overwrite each other — the viewer identity keys them.
    const stored = JSON.parse(
      readFileSync(join(tempHome, '.orca', 'jira-sites.json'), 'utf-8')
    ) as {
      sites: { accountId: string }[]
    }
    expect(stored.sites).toHaveLength(2)
    expect(stored.sites.map((site) => site.accountId).sort()).toEqual(['alice', 'bot'])
  })

  it('uses Bearer auth and REST v2 for stored self-hosted sites', async () => {
    const siteId = 'site-server'
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: 'https://jira.example.com',
            email: '',
            displayName: 'William',
            accountId: 'wquintal',
            authType: 'server'
          }
        ]
      }),
      { encoding: 'utf-8' }
    )
    writeFileSync(tokenPathForSite(siteId), 'pat-token')
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'wquintal', displayName: 'William' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule()

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'William' }
    })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/2/myself',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer pat-token')
  })

  it('bridges proxy environment settings before Jira connect requests', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accountId: 'account-alpha',
          displayName: 'Ada',
          emailAddress: 'ada@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'example.atlassian.net',
        email: 'ada@example.com',
        apiToken: 'token-alpha'
      })
    ).resolves.toMatchObject({ ok: true, viewer: { displayName: 'Ada' } })

    expect(resolveProxyMock).toHaveBeenCalledWith('https://example.atlassian.net/rest/api/3/myself')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('User-Agent')).toBe('Orca')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
