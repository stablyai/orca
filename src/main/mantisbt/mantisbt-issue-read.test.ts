import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock, resolveProxyMock, setProxyMock, closeAllConnectionsMock } = vi.hoisted(
  () => ({
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn(),
    closeAllConnectionsMock: vi.fn()
  })
)

const OLD_FETCH = globalThis.fetch
let tempHome = ''

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

function writeMantisBTSites(
  sites: { id: string; siteUrl: string; userId: string; token: string }[]
): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'mantisBT-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'mantisBT-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: sites[0]?.id ?? null,
        selectedSiteId: 'all',
        sites: sites.map((site) => ({
          id: site.id,
          siteUrl: site.siteUrl,
          userId: site.userId,
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

function makeIssueRecord(id: number, summary = `Issue ${id}`): Record<string, unknown> {
  return {
    id,
    summary,
    project: { id: 1, name: 'Demo' },
    status: { id: 10, name: 'new', label: 'new' },
    reporter: { id: 1, name: 'reporter' },
    handler: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-02T00:00:00.000Z'
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' }
  })
}

async function loadIssueReadModule() {
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
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements only resolveProxy/setProxy, the two proxySession operations mantisBTFetch calls.
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  const [client, issueRead] = await Promise.all([
    import('./client'),
    import('./mantisbt-issue-read')
  ])
  return { ...client, ...issueRead }
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-mantisBT-issue-read-')
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated-request.ts routes every call through httpClient.fetch (netFetchMock); this stub only guards against an accidental fallback to the raw global.
  globalThis.fetch = vi.fn(async () => {
    throw new Error('fetch should not be called')
  }) as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('MantisBT getIssue', () => {
  it('finds and maps the issue from the first site that has it', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () => jsonResponse({ issues: [makeIssueRecord(1)] }))
    const mantisBT = await loadIssueReadModule()

    const issue = await mantisBT.getIssue('1', 'site-a')

    expect(issue?.id).toBe('1')
    expect(issue?.summary).toBe('Issue 1')
    expect(issue?.siteId).toBe('site-a')
  })

  it('tries the next site when the first returns 404, and finds it there', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://alpha.example.com')) {
        return jsonResponse({ message: 'Issue not found' }, 404)
      }
      return jsonResponse({ issues: [makeIssueRecord(1)] })
    })
    const mantisBT = await loadIssueReadModule()

    const issue = await mantisBT.getIssue('1', 'all')

    expect(issue?.id).toBe('1')
    expect(issue?.siteId).toBe('beta')
  })

  it('returns null when every connected site cleanly 404s', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async () => jsonResponse({ message: 'Not found' }, 404))
    const mantisBT = await loadIssueReadModule()

    const issue = await mantisBT.getIssue('1', 'all')

    expect(issue).toBeNull()
  })

  it('throws immediately for a specific single-site selection on a non-404, non-auth error', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () =>
      jsonResponse({ message: 'Database unavailable' }, 500)
    )
    const mantisBT = await loadIssueReadModule()

    await expect(mantisBT.getIssue('1', 'site-a')).rejects.toThrow('Database unavailable')
  })

  it("throws rather than returning null when one 'all' site 404s cleanly and the other genuinely fails", async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://alpha.example.com')) {
        return jsonResponse({ message: 'Not found' }, 404)
      }
      return jsonResponse({ message: 'Site beta exploded' }, 500)
    })
    const mantisBT = await loadIssueReadModule()

    await expect(mantisBT.getIssue('1', 'all')).rejects.toThrow('Site beta exploded')
  })

  it('evicts only the failing site token on a 401 and still finds the issue on the healthy site', async () => {
    writeMantisBTSites([
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' },
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://beta.example.com')) {
        return jsonResponse({ message: 'Access denied' }, 401)
      }
      return jsonResponse({ issues: [makeIssueRecord(1)] })
    })
    const mantisBT = await loadIssueReadModule()

    const issue = await mantisBT.getIssue('1', 'all')

    expect(issue?.id).toBe('1')
    expect(issue?.siteId).toBe('alpha')
    expect(existsSync(tokenPathForSite('beta'))).toBe(false)
    expect(mantisBT.getStatus().sites.map((site) => site.id)).toEqual(['alpha'])
  })
})
