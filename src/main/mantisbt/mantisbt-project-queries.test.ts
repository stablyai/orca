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

function makeProjectRecord(
  id: number,
  name: string,
  subProjects: { id: number; name: string }[] = []
): Record<string, unknown> {
  return { id, name, subProjects }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' }
  })
}

async function loadProjectQueriesModule() {
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

  const [client, projectQueries] = await Promise.all([
    import('./client'),
    import('./mantisbt-project-queries')
  ])
  return { ...client, ...projectQueries }
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-mantisBT-project-queries-')
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

describe('MantisBT listProjects', () => {
  it('returns the merged, name-sorted project list from two healthy connected sites', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://alpha.example.com')) {
        return jsonResponse({ projects: [makeProjectRecord(1, 'Zebra')] })
      }
      return jsonResponse({ projects: [makeProjectRecord(2, 'Apple')] })
    })
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('all')

    expect(projects.map((project) => project.name)).toEqual(['Apple', 'Zebra'])
  })

  it("does not collapse two different sites' projects that share the same raw project id", async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://alpha.example.com')) {
        return jsonResponse({ projects: [makeProjectRecord(1, 'Alpha Default')] })
      }
      return jsonResponse({ projects: [makeProjectRecord(1, 'Beta Default')] })
    })
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('all')

    expect(projects).toHaveLength(2)
    const bySite = new Map(projects.map((project) => [project.siteId, project]))
    expect(bySite.get('alpha')?.name).toBe('Alpha Default')
    expect(bySite.get('alpha')?.id).toBe('1')
    expect(bySite.get('beta')?.name).toBe('Beta Default')
    expect(bySite.get('beta')?.id).toBe('1')
  })

  it('throws immediately for a specific single-site selection on a non-auth failure', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () =>
      jsonResponse({ message: 'Database unavailable' }, 500)
    )
    const mantisBT = await loadProjectQueriesModule()

    await expect(mantisBT.listProjects('site-a')).rejects.toThrow('Database unavailable')
  })

  it("tolerates one site's non-auth failure under an 'all' selection and returns the healthy site's projects", async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://beta.example.com')) {
        return jsonResponse({ message: 'Site beta exploded' }, 500)
      }
      return jsonResponse({ projects: [makeProjectRecord(1, 'Demo')] })
    })
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('all')

    expect(projects).toHaveLength(1)
    expect(projects[0]?.siteId).toBe('alpha')
  })

  it("throws when every connected site fails under an 'all' selection", async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async () => jsonResponse({ message: 'All sites down' }, 500))
    const mantisBT = await loadProjectQueriesModule()

    await expect(mantisBT.listProjects('all')).rejects.toThrow('All sites down')
  })

  it('evicts only the failing site token on a 401 and still returns the healthy site projects', async () => {
    writeMantisBTSites([
      { id: 'alpha', siteUrl: 'https://alpha.example.com', userId: 'user-a', token: 'token-a' },
      { id: 'beta', siteUrl: 'https://beta.example.com', userId: 'user-b', token: 'token-b' }
    ])
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://beta.example.com')) {
        return jsonResponse({ message: 'Access denied' }, 401)
      }
      return jsonResponse({ projects: [makeProjectRecord(1, 'Demo')] })
    })
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('all')

    expect(projects).toHaveLength(1)
    expect(projects[0]?.siteId).toBe('alpha')
    expect(existsSync(tokenPathForSite('beta'))).toBe(false)
    expect(mantisBT.getStatus().sites.map((site) => site.id)).toEqual(['alpha'])
  })

  it('moves a subproject out of the top-level list and nests it under its parent', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () =>
      jsonResponse({
        projects: [
          makeProjectRecord(1, 'QCS-VS', [{ id: 2, name: 'QCS App' }]),
          makeProjectRecord(2, 'QCS App'),
          makeProjectRecord(3, 'Standalone')
        ]
      })
    )
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('site-a')

    expect(projects.map((project) => project.name)).toEqual(['QCS-VS', 'Standalone'])
    const qcsVs = projects.find((project) => project.name === 'QCS-VS')
    expect(qcsVs?.subProjects.map((project) => project.name)).toEqual(['QCS App'])
  })

  it('resolves a multi-level subproject chain, not just one level deep', async () => {
    writeMantisBTSites([
      { id: 'site-a', siteUrl: 'https://mantisbt.example.com', userId: '42', token: 'token-a' }
    ])
    netFetchMock.mockImplementation(async () =>
      jsonResponse({
        projects: [
          makeProjectRecord(1, 'Ewarenow', [{ id: 2, name: 'EQQ' }]),
          makeProjectRecord(2, 'EQQ', [{ id: 3, name: 'EQQ Application' }]),
          makeProjectRecord(3, 'EQQ Application')
        ]
      })
    )
    const mantisBT = await loadProjectQueriesModule()

    const projects = await mantisBT.listProjects('site-a')

    expect(projects.map((project) => project.name)).toEqual(['Ewarenow'])
    const eqq = projects[0]?.subProjects[0]
    expect(eqq?.name).toBe('EQQ')
    expect(eqq?.subProjects.map((project) => project.name)).toEqual(['EQQ Application'])
  })
})
