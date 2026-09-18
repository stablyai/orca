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

function makeIssueRecord(
  id: number,
  handlerId: number | null,
  updatedAt: string,
  reporterId = 1
): Record<string, unknown> {
  return {
    id,
    summary: `Issue ${id}`,
    project: { id: 1, name: 'Demo' },
    status: { id: 10, name: 'new', label: 'new' },
    reporter: { id: reporterId, name: 'reporter' },
    handler: handlerId === null ? null : { id: handlerId, name: 'handler' },
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: updatedAt
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' }
  })
}

async function loadSearchModule() {
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

  const [client, search] = await Promise.all([
    import('./client'),
    import('./mantisbt-issue-search')
  ])
  return { ...client, ...search }
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-mantisBT-search-')
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

describe('MantisBT listIssues', () => {
  it('filters to issues whose handler matches the resolved viewer id', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ user: { id: 42, name: 'wq', real_name: 'William' } })
      }
      return jsonResponse({
        issues: [
          makeIssueRecord(1, 42, '2024-02-01T00:00:00.000Z'),
          makeIssueRecord(2, 99, '2024-02-02T00:00:00.000Z')
        ]
      })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('assigned', 30, 'site-a')

    expect(issues.map((issue) => issue.id)).toEqual(['1'])
  })

  it('filters to issues whose reporter matches the resolved viewer id', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ user: { id: 42, name: 'wq', real_name: 'William' } })
      }
      return jsonResponse({
        issues: [
          makeIssueRecord(1, null, '2024-02-01T00:00:00.000Z', 42),
          makeIssueRecord(2, null, '2024-02-02T00:00:00.000Z', 99)
        ]
      })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('reported', 30, 'site-a')

    expect(issues.map((issue) => issue.id)).toEqual(['1'])
  })

  it('returns every issue regardless of handler when filter is all', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      return jsonResponse({
        issues: [
          makeIssueRecord(1, 42, '2024-02-01T00:00:00.000Z'),
          makeIssueRecord(2, 99, '2024-02-02T00:00:00.000Z')
        ]
      })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('all', 30, 'site-a')

    expect(issues.map((issue) => issue.id).sort()).toEqual(['1', '2'])
  })

  it('includes project_id in the request when a project filter is provided', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    let capturedUrl = ''
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      capturedUrl = url
      return jsonResponse({ issues: [makeIssueRecord(1, 42, '2024-02-01T00:00:00.000Z')] })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('all', 30, 'site-a', '50')

    expect(issues.map((issue) => issue.id)).toEqual(['1'])
    expect(capturedUrl).toContain('project_id=50')
  })

  it('omits project_id from the request when no project filter is provided', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    let capturedUrl = ''
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      capturedUrl = url
      return jsonResponse({ issues: [makeIssueRecord(1, 42, '2024-02-01T00:00:00.000Z')] })
    })
    const mantisBT = await loadSearchModule()

    await mantisBT.listIssues('all', 30, 'site-a')

    expect(capturedUrl).not.toContain('project_id')
  })

  it('retries a page once after a transient truncated-JSON response and succeeds', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    let issuesCallCount = 0
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      issuesCallCount += 1
      if (issuesCallCount === 1) {
        return new Response('{"issues": [', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return jsonResponse({ issues: [makeIssueRecord(1, 42, '2024-02-01T00:00:00.000Z')] })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('all', 30, 'site-a')

    expect(issues.map((issue) => issue.id)).toEqual(['1'])
    expect(issuesCallCount).toBe(2)
  })

  it('gives up after exhausting retries on a persistently truncated response', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    let issuesCallCount = 0
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      issuesCallCount += 1
      return new Response('{"issues": [', {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const mantisBT = await loadSearchModule()

    await expect(mantisBT.listIssues('all', 30, 'site-a')).rejects.toThrow(SyntaxError)
    expect(issuesCallCount).toBe(3)
  })

  it('walks multiple pages until a short page is returned', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    const page1 = Array.from({ length: 50 }, (_, index) =>
      makeIssueRecord(index + 1, null, '2024-01-01T00:00:00.000Z')
    )
    const page2 = Array.from({ length: 3 }, (_, index) =>
      makeIssueRecord(51 + index, null, '2024-01-02T00:00:00.000Z')
    )
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('page=2')) {
        return jsonResponse({ issues: page2 })
      }
      return jsonResponse({ issues: page1 })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('all', 100, 'site-a')

    expect(issues).toHaveLength(53)
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports cumulative filtered issues to onProgress as each page arrives', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    const page1 = Array.from({ length: 50 }, (_, index) =>
      makeIssueRecord(index + 1, null, '2024-01-01T00:00:00.000Z')
    )
    const page2 = [makeIssueRecord(51, null, '2024-01-02T00:00:00.000Z')]
    netFetchMock.mockImplementation(async (url: string) => {
      expect(url).not.toContain('/users/me')
      if (url.includes('page=2')) {
        return jsonResponse({ issues: page2 })
      }
      return jsonResponse({ issues: page1 })
    })
    const mantisBT = await loadSearchModule()
    const progressSnapshots: number[] = []

    const issues = await mantisBT.listIssues('all', 100, 'site-a', null, undefined, (batch) =>
      progressSnapshots.push(batch.length)
    )

    expect(issues).toHaveLength(51)
    expect(progressSnapshots).toEqual([50, 51])
  })

  it('does not report progress when more than one site is fetched', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'u1', token: 'token-alpha' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'u2', token: 'token-beta' }
    ])
    netFetchMock.mockImplementation(async () =>
      jsonResponse({ issues: [makeIssueRecord(1, null, '2024-01-01T00:00:00.000Z')] })
    )
    const mantisBT = await loadSearchModule()
    const onProgress = vi.fn()

    await mantisBT.listIssues('all', 30, 'all', null, undefined, onProgress)

    expect(onProgress).not.toHaveBeenCalled()
  })

  it('evicts only the failing site token on a 401 and still returns the healthy site issues', async () => {
    writeMantisBTSites([
      {
        id: 'alpha',
        siteUrl: 'https://alpha.example.com',
        userId: 'user-alpha',
        token: 'token-alpha'
      },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-beta', token: 'token-beta' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://beta.example.com')) {
        return jsonResponse({ message: 'Access denied' }, 401)
      }
      return jsonResponse({ issues: [makeIssueRecord(1, null, '2024-01-01T00:00:00.000Z')] })
    })
    const mantisBT = await loadSearchModule()

    const issues = await mantisBT.listIssues('all', 30, 'all')

    expect(issues).toHaveLength(1)
    expect(issues[0]?.siteId).toBe('alpha')
    expect(existsSync(tokenPathForSite('beta'))).toBe(false)
    expect(mantisBT.getStatus().sites.map((site) => site.id)).toEqual(['alpha'])
  })

  it('throws for a specific single-site selection when that site returns a 500', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () => jsonResponse({ message: 'Internal error' }, 500))
    const mantisBT = await loadSearchModule()

    await expect(mantisBT.listIssues('all', 30, 'site-a')).rejects.toThrow('Internal error')
  })

  it('throws when every connected site fails under an all selection', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-alpha', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-beta', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async () => jsonResponse({ message: 'Internal error' }, 500))
    const mantisBT = await loadSearchModule()

    await expect(mantisBT.listIssues('all', 30, 'all')).rejects.toThrow('Internal error')
  })

  it('throws MantisBTPaginationLimitError instead of silently truncating a huge result set', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    // Every page comes back full (50 items), so the server never signals the
    // end of the list — this must trip the pagination safety guard.
    netFetchMock.mockImplementation(async () =>
      jsonResponse({
        issues: Array.from({ length: 50 }, (_, index) =>
          makeIssueRecord(index + 1, null, '2024-01-01T00:00:00.000Z')
        )
      })
    )
    const mantisBT = await loadSearchModule()

    await expect(mantisBT.listIssues('all', 30, 'site-a')).rejects.toThrow(
      /pagination safety limit/
    )
  })
})
