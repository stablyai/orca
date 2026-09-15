import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJiraTempHome,
  jiraTokenPath,
  loadJiraClientModule,
  resetJiraClientMocks,
  type SafeStorageMockOptions
} from './client-test-harness'

const OLD_FETCH = globalThis.fetch
const mocks = vi.hoisted(() => ({
  closeAllConnectionsMock: vi.fn(),
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))
const { netFetchMock } = mocks

let tempHome = ''

function tokenPathForSite(siteId: string): string {
  return jiraTokenPath(tempHome, siteId)
}

function loadClientModule(options: SafeStorageMockOptions = {}) {
  return loadJiraClientModule(mocks, tempHome, options)
}

beforeEach(() => {
  tempHome = createJiraTempHome()
  resetJiraClientMocks(mocks)
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Jira client scoped Atlassian API tokens', () => {
  it('connects a scoped Cloud token through the api.atlassian.com gateway', async () => {
    // Why: Atlassian rejects scoped tokens on the site host, so the cloud id is
    // resolved first and every REST call (including later reads) uses the gateway.
    netFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudId: 'cloud-abc' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accountId: 'account-alpha', displayName: 'Ada' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accountId: 'account-alpha', displayName: 'Ada' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'example.atlassian.net',
        email: 'ada@example.com',
        apiToken: 'scoped-token',
        authType: 'cloud-scoped'
      })
    ).resolves.toMatchObject({ ok: true, viewer: { displayName: 'Ada' } })

    expect(netFetchMock.mock.calls[0]?.[0]).toBe('https://example.atlassian.net/_edge/tenant_info')
    expect(netFetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/myself'
    )
    const headers = netFetchMock.mock.calls[1]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada@example.com:scoped-token').toString('base64')}`
    )

    const siteFile = JSON.parse(
      readFileSync(join(tempHome, '.orca', 'jira-sites.json'), { encoding: 'utf-8' })
    ) as { sites: { siteUrl: string; authType: string; apiBaseUrl?: string }[] }
    expect(siteFile.sites[0]).toMatchObject({
      siteUrl: 'https://example.atlassian.net',
      authType: 'cloud-scoped',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc'
    })
    expect(jira.getStatus().viewer?.displayName).toBe('Ada')

    await expect(jira.testConnection()).resolves.toMatchObject({ ok: true })
    expect(netFetchMock.mock.calls[2]?.[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/myself'
    )
  })

  it('sends a scoped Cloud token as Bearer when no email is given', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudId: 'cloud-abc' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accountId: 'account-alpha', displayName: 'Ada' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'https://example.atlassian.net',
        email: '',
        apiToken: 'scoped-token',
        authType: 'cloud-scoped'
      })
    ).resolves.toMatchObject({ ok: true, viewer: { accountId: 'account-alpha' } })
    const headers = netFetchMock.mock.calls[1]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer scoped-token')
  })

  it('reports a scoped Cloud connection whose cloud id cannot be resolved', async () => {
    netFetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        siteUrl: 'jira.example.com',
        email: '',
        apiToken: 'scoped-token',
        authType: 'cloud-scoped'
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('cloud id') })
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const SITE_REJECTION = {
    errorMessages: ['Client must be authenticated to access this resource.']
  }

  function connectCloud(jira: Awaited<ReturnType<typeof loadClientModule>>) {
    return jira.connect({
      siteUrl: 'example.atlassian.net',
      email: 'ada@example.com',
      apiToken: 'some-token',
      authType: 'cloud'
    })
  }

  it('routes a Cloud token through the gateway when the site host rejects it', async () => {
    // Why: scoped tokens only work on the gateway, so the dialog does not ask
    // which kind of token it is; a site-host 401 triggers the gateway attempt.
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(401, SITE_REJECTION))
      .mockResolvedValueOnce(jsonResponse(200, { cloudId: 'cloud-abc' }))
      .mockResolvedValueOnce(jsonResponse(200, { accountId: 'account-alpha', displayName: 'Ada' }))
    const jira = await loadClientModule()

    await expect(connectCloud(jira)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada' }
    })

    expect(netFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://example.atlassian.net/rest/api/3/myself',
      'https://example.atlassian.net/_edge/tenant_info',
      'https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/myself'
    ])
    const headers = netFetchMock.mock.calls[2]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada@example.com:some-token').toString('base64')}`
    )
    expect(jira.getStatus().sites?.[0]).toMatchObject({
      authType: 'cloud-scoped',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc'
    })
  })

  it('reports the site-host error when the gateway also rejects a Cloud token', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(401, SITE_REJECTION))
      .mockResolvedValueOnce(jsonResponse(200, { cloudId: 'cloud-abc' }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 401, message: 'Unauthorized' }))
    const jira = await loadClientModule()

    await expect(connectCloud(jira)).resolves.toEqual({
      ok: false,
      error: 'Client must be authenticated to access this resource.'
    })
    expect(jira.getStatus().sites ?? []).toEqual([])
  })

  it('reports a missing scope found on the gateway attempt', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(401, SITE_REJECTION))
      .mockResolvedValueOnce(jsonResponse(200, { cloudId: 'cloud-abc' }))
      .mockResolvedValueOnce(
        jsonResponse(401, { code: 401, message: 'Unauthorized; scope does not match' })
      )
    const jira = await loadClientModule()

    const result = await connectCloud(jira)

    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).toContain('missing a scope this request needs')
  })

  it('reports the site-host error when the site has no Atlassian cloud id', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(401, SITE_REJECTION))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const jira = await loadClientModule()

    await expect(connectCloud(jira)).resolves.toEqual({
      ok: false,
      error: 'Client must be authenticated to access this resource.'
    })
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not try the gateway when the site host fails for another reason', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(500, { errorMessages: ['Internal error'] }))
    const jira = await loadClientModule()

    await expect(connectCloud(jira)).resolves.toEqual({ ok: false, error: 'Internal error' })
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-roots scoped-site attachment URLs from the site host onto the gateway', async () => {
    const jira = await loadClientModule({ encryptionAvailable: true })
    const client = {
      site: {
        id: 'site-scoped',
        siteUrl: 'https://example.atlassian.net',
        email: '',
        displayName: 'Ada',
        accountId: 'account-alpha',
        authType: 'cloud-scoped' as const,
        apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc'
      },
      authorization: 'Bearer scoped-token'
    }
    netFetchMock.mockResolvedValueOnce(
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      })
    )

    await expect(
      jira.jiraRequestBinary(
        client,
        'https://example.atlassian.net/rest/api/3/attachment/content/1?redirect=false'
      )
    ).resolves.toMatchObject({ contentType: 'image/png' })
    expect(netFetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/attachment/content/1?redirect=false'
    )

    await expect(
      jira.jiraRequestBinary(client, 'https://files.example.com/attachment.png')
    ).rejects.toThrow('configured site origin')
    // Why: the gateway origin is shared by every tenant, so a URL under another
    // cloud id must be refused before the token is attached.
    await expect(
      jira.jiraRequestBinary(
        client,
        'https://api.atlassian.com/ex/jira/other-cloud/rest/api/3/attachment/content/1'
      )
    ).rejects.toThrow('configured site origin')
    await expect(
      jira.jiraRequestBinary(
        client,
        'https://api.atlassian.com/ex/jira/cloud-abc-2/rest/api/3/attachment/content/1'
      )
    ).rejects.toThrow('configured site origin')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops a stored scoped site whose gateway URL is not an api.atlassian.com cloud id', async () => {
    // Why: apiBaseUrl decides where the scoped token is sent, so an edited
    // jira-sites.json must not be able to point it at another host.
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    const site = (id: string, apiBaseUrl: string) => ({
      id,
      siteUrl: 'https://example.atlassian.net',
      email: '',
      displayName: 'Ada',
      accountId: 'account-alpha',
      authType: 'cloud-scoped',
      apiBaseUrl
    })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: 'site-ok',
        selectedSiteId: 'site-ok',
        sites: [
          site('site-ok', 'https://api.atlassian.com/ex/jira/cloud-abc'),
          site('site-encoded', 'https://api.atlassian.com/ex/jira/cloud%20abc'),
          site('site-host', 'https://evil.example.com/ex/jira/cloud-abc'),
          site('site-port', 'https://api.atlassian.com:8443/ex/jira/cloud-abc'),
          site('site-path', 'https://api.atlassian.com/ex/jira/cloud-abc/extra'),
          site('site-http', 'http://api.atlassian.com/ex/jira/cloud-abc'),
          site('site-bad-escape', 'https://api.atlassian.com/ex/jira/cloud%ZZabc'),
          site('site-trailing-percent', 'https://api.atlassian.com/ex/jira/cloud-abc%')
        ]
      }),
      { encoding: 'utf-8' }
    )
    for (const id of [
      'site-ok',
      'site-encoded',
      'site-host',
      'site-port',
      'site-path',
      'site-http',
      'site-bad-escape',
      'site-trailing-percent'
    ]) {
      writeFileSync(tokenPathForSite(id), 'scoped-token')
    }
    const jira = await loadClientModule()

    expect(jira.getStatus().sites?.map((entry) => entry.id)).toEqual(['site-ok', 'site-encoded'])
  })

  function writeScopedSite(): void {
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: 'site-scoped',
        selectedSiteId: 'site-scoped',
        sites: [
          {
            id: 'site-scoped',
            siteUrl: 'https://example.atlassian.net',
            email: '',
            displayName: 'Ada',
            accountId: 'account-alpha',
            authType: 'cloud-scoped',
            apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-abc'
          }
        ]
      }),
      { encoding: 'utf-8' }
    )
    writeFileSync(tokenPathForSite('site-scoped'), 'scoped-token')
  }

  it('keeps a scoped site when the gateway rejects one endpoint for a missing scope', async () => {
    // Why: the board API needs Jira Software scopes the token may not carry; that
    // gap must not delete a token that still works for every other endpoint.
    writeScopedSite()
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule()
    const { getProjectStatusOrder } = await import('./jira-transition-queries')

    await expect(getProjectStatusOrder('ENG', 'site-scoped')).resolves.toEqual({
      statusIdsByColumn: []
    })
    expect(netFetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-abc/rest/agile/1.0/board?projectKeyOrId=ENG&maxResults=2'
    )
    expect(jira.getStatus().sites?.map((entry) => entry.id)).toEqual(['site-scoped'])
    expect(existsSync(tokenPathForSite('site-scoped'))).toBe(true)
  })

  it('explains a missing scope when a scoped-token write is rejected', async () => {
    writeScopedSite()
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule()
    const { updateIssue } = await import('./jira-issue-mutations')

    const result = await updateIssue('ENG-1', { title: 'Renamed' }, 'site-scoped')

    expect(result).toMatchObject({ ok: false })
    const error = result.ok ? '' : result.error
    expect(error).toContain('missing a scope this request needs')
    expect(error).toContain('scopes listed in the Jira connect dialog')
    expect(error).toContain('scope does not match')
    expect(jira.getStatus().sites?.map((entry) => entry.id)).toEqual(['site-scoped'])
  })

  it('explains a missing scope when connecting a scoped token', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudId: 'cloud-abc' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const jira = await loadClientModule()

    const result = await jira.connect({
      siteUrl: 'example.atlassian.net',
      email: '',
      apiToken: 'scoped-token',
      authType: 'cloud-scoped'
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).toContain('missing a scope this request needs')
  })

  it('still removes a scoped site whose token the gateway rejects outright', async () => {
    writeScopedSite()
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errorMessages: ['Client must be authenticated to access this resource.']
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule()
    const { getProjectStatusOrder } = await import('./jira-transition-queries')

    await expect(getProjectStatusOrder('ENG', 'site-scoped')).rejects.toMatchObject({
      status: 401
    })
    expect(jira.getStatus().sites ?? []).toEqual([])
    expect(existsSync(tokenPathForSite('site-scoped'))).toBe(false)
  })
})
