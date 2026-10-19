import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadJiraClientModule } from './__mocks__/jira-client-module'
import { jiraFixtureJson, startJiraAuthFixture } from './auth-http-fixture'

const SITE = 'https://example.atlassian.net'
const GATEWAY = 'https://api.atlassian.com/ex/jira/cloud-abc'
const VIEWER = { accountId: 'account-alpha', displayName: 'Ada' }
const CREDENTIAL = { siteUrl: SITE, email: 'ada@example.com', apiToken: 'private-token' }
const mocks = vi.hoisted(() => ({
  closeAllConnectionsMock: vi.fn(),
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))
let tempHome = ''
let fixture: Awaited<ReturnType<typeof startJiraAuthFixture>> | undefined

async function loadClient() {
  const jira = await loadJiraClientModule(mocks, tempHome, { encryptionAvailable: true })
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => {
      if (!fixture) {
        throw new Error('Start the Jira HTTP fixture first')
      }
      return fixture.fetch(url, init)
    },
    proxySession: () => null
  })
  return jira
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jira-scoped-'))
})

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
  rmSync(tempHome, { recursive: true, force: true })
})

describe('scoped Jira Cloud tokens over HTTP', () => {
  it('refuses redirects from gateway credential, API and attachment requests', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url.endsWith('/_edge/tenant_info')) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else {
        response.writeHead(302, { Location: `${GATEWAY}/other-tenant` })
        response.end()
      }
    })
    const jira = await loadClient()
    await expect(jira.connect({ ...CREDENTIAL, email: '' })).resolves.toMatchObject({ ok: false })
    expect(fixture.requests).toHaveLength(2)
    const client = {
      site: {
        id: 'scoped',
        siteUrl: SITE,
        email: '',
        displayName: 'Ada',
        accountId: 'account-alpha',
        authType: 'cloud' as const,
        apiBaseUrl: GATEWAY
      },
      authorization: 'Bearer private-token'
    }
    await expect(jira.jiraRequest(client, '/rest/api/3/issue/ALP-1')).rejects.toThrow()
    await expect(
      jira.jiraRequestBinary(client, `${SITE}/rest/api/3/attachment/content/1`)
    ).rejects.toThrow()
    expect(fixture.requests).toHaveLength(4)
    expect(fixture.requests.every((request) => !request.url.endsWith('/other-tenant'))).toBe(true)
  })

  it('revokes cached attachment bytes only after replacing a verified credential', async () => {
    let authorized = true
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url.endsWith('/_edge/tenant_info')) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else {
        jiraFixtureJson(response, authorized ? 200 : 401, authorized ? VIEWER : {})
      }
    })
    const jira = await loadClient()
    await jira.connect(CREDENTIAL)
    const client = jira.getClients()[0]
    if (!client) {
      throw new Error('Expected connected Jira client')
    }
    const cache = await import('./attachment-image-cache')
    cache.setCachedAttachmentDataUrl({
      siteId: client.site.id,
      attachmentId: 'image',
      dataUrl: 'data:image/png;base64,AQ==',
      byteSize: 1
    })
    const epoch = cache.attachmentImagesEpoch(client.site.id)
    authorized = false
    await expect(
      jira.connect({ ...CREDENTIAL, apiToken: 'rejected-token' })
    ).resolves.toMatchObject({ ok: false })
    expect(cache.getCachedAttachmentDataUrl(client.site.id, 'image')).not.toBeNull()
    expect(cache.attachmentImagesEpoch(client.site.id)).toBe(epoch)
    authorized = true
    await expect(
      jira.connect({ ...CREDENTIAL, apiToken: 'replacement-token' })
    ).resolves.toMatchObject({ ok: true })
    expect(cache.getCachedAttachmentDataUrl(client.site.id, 'image')).toBeNull()
    expect(cache.attachmentImagesEpoch(client.site.id)).toBeGreaterThan(epoch)
    expect(jira.getClients()[0]?.authorization).toBe(
      `Basic ${Buffer.from('ada@example.com:replacement-token').toString('base64')}`
    )
    cache._resetAttachmentImageCache()
  })

  it('preserves the installation path in self-hosted attachment URLs', async () => {
    fixture = await startJiraAuthFixture((_request, response) => {
      jiraFixtureJson(response, 200, { image: true })
    })
    const jira = await loadClient()
    const attachmentUrl = `${SITE}/jira/secure/attachment/1/shot.png?download=true`
    await jira.jiraRequestBinary(
      {
        site: {
          id: 'server',
          siteUrl: `${SITE}/jira`,
          email: '',
          displayName: 'Ada',
          accountId: 'ada',
          authType: 'server'
        },
        authorization: 'Bearer private-token'
      },
      attachmentUrl
    )
    expect(fixture.requests.map((request) => request.url)).toEqual([attachmentUrl])
  })

  it('resolves the tenant without a credential and connects an email-free Bearer token', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url === `${SITE}/_edge/tenant_info`) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else if (request.url === `${GATEWAY}/rest/api/3/myself`) {
        jiraFixtureJson(response, 200, VIEWER)
      } else {
        jiraFixtureJson(response, 401, {})
      }
    })
    const jira = await loadClient()

    await expect(jira.connect({ ...CREDENTIAL, email: '' })).resolves.toMatchObject({
      ok: true,
      viewer: VIEWER
    })
    expect(fixture.requests).toEqual([
      { url: `${SITE}/_edge/tenant_info`, authorization: undefined, method: 'GET' },
      {
        url: `${GATEWAY}/rest/api/3/myself`,
        authorization: 'Bearer private-token',
        method: 'GET'
      }
    ])
  })

  it('retries site-rejected Basic tokens on the gateway and keeps that route after reload', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url === `${SITE}/_edge/tenant_info`) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else if (request.url.startsWith(`${GATEWAY}/`)) {
        jiraFixtureJson(response, 200, VIEWER)
      } else {
        jiraFixtureJson(response, 401, { errorMessages: ['Client must be authenticated.'] })
      }
    })
    const jira = await loadClient()

    await expect(jira.connect(CREDENTIAL)).resolves.toMatchObject({ ok: true })
    const stored = JSON.parse(readFileSync(join(tempHome, '.orca', 'jira-sites.json'), 'utf8'))
    expect(stored.sites[0]).toMatchObject({
      siteUrl: SITE,
      authType: 'cloud',
      apiBaseUrl: GATEWAY
    })
    const reloaded = await loadClient()
    await expect(reloaded.testConnection()).resolves.toMatchObject({ ok: true })
    expect(fixture.requests.at(-1)).toMatchObject({
      url: `${GATEWAY}/rest/api/3/myself`,
      authorization: `Basic ${Buffer.from('ada@example.com:private-token').toString('base64')}`
    })
    expect(reloaded.getStatus()).toMatchObject({ supportsScopedTokens: true })
  })

  it('routes reads, edits and site attachment links through the selected gateway tenant', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url.endsWith('/_edge/tenant_info')) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else if (request.url.endsWith('/myself')) {
        jiraFixtureJson(response, 200, VIEWER)
      } else {
        jiraFixtureJson(response, 200, { issues: [] })
      }
    })
    const jira = await loadClient()
    await jira.connect({ ...CREDENTIAL, email: '' })
    const client = jira.getClients()[0]
    if (!client) {
      throw new Error('Expected connected scoped Jira client')
    }
    await jira.jiraRequest(client, '/rest/api/3/issue/ALP-1', { method: 'PUT', body: '{}' })
    await jira.jiraRequestBinary(client, `${SITE}/rest/api/3/attachment/content/1?redirect=false`)
    expect(fixture.requests.slice(-2).map((request) => request.url)).toEqual([
      `${GATEWAY}/rest/api/3/issue/ALP-1`,
      `${GATEWAY}/rest/api/3/attachment/content/1?redirect=false`
    ])
    for (const url of [
      'https://evil.example/attachment.png',
      `${SITE}/secure/attachment/1/shot.png`,
      `${SITE}/rest-other/attachment/1/shot.png`,
      'https://api.atlassian.com/ex/jira/other-cloud/rest/api/3/attachment/content/1',
      `${GATEWAY}-other/rest/api/3/attachment/content/1`,
      `${GATEWAY}/../other-cloud/rest/api/3/attachment/content/1`
    ]) {
      await expect(jira.jiraRequestBinary(client, url)).rejects.toThrow(
        /configured site|REST content URL/
      )
    }
    expect(fixture.requests).toHaveLength(4)
  })

  it('retains saved credentials when a later search lacks scopes', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url.endsWith('/_edge/tenant_info')) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else if (request.url.endsWith('/myself')) {
        jiraFixtureJson(response, 200, VIEWER)
      } else {
        jiraFixtureJson(response, 401, { message: 'Unauthorized; scope does not match' })
      }
    })
    const jira = await loadClient()
    await jira.connect({ ...CREDENTIAL, email: '' })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues()).rejects.toThrow('scope')
    expect(jira.getStatus().connected).toBe(true)
    expect(jira.getClients()).toHaveLength(1)
  })

  it('recognizes scope failures in authentication headers without clearing the token', async () => {
    fixture = await startJiraAuthFixture((_request, response) => {
      response.setHeader('WWW-Authenticate', 'Bearer error="insufficient_scope"')
      jiraFixtureJson(response, 401, {})
    })
    const jira = await loadClient()
    const error = await jira
      .requestWithCredentials(GATEWAY, '', 'private-token', '/rest/api/3/myself')
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(jira.JiraApiError)
    expect(jira.isAuthError(error)).toBe(false)
  })

  it('identifies both rejected endpoints safely, including a reflected secret', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url.endsWith('/_edge/tenant_info')) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else {
        jiraFixtureJson(response, 401, { message: 'Rejected private-token' })
      }
    })
    const jira = await loadClient()
    const result = await jira.connect(CREDENTIAL)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) {
      throw new Error('Expected rejected credentials')
    }
    expect(result.error).toContain('example.atlassian.net/rest/api/3/myself (HTTP 401)')
    expect(result.error).toContain('api.atlassian.com')
    expect(result.error).toContain('email')
    expect(result.error).not.toContain('private-token')
    expect(jira.getStatus().connected).toBe(false)
  })

  it('reports unauthenticated tenant lookup failures without calling a gateway', async () => {
    fixture = await startJiraAuthFixture((_request, response) => {
      jiraFixtureJson(response, 404, {})
    })
    const jira = await loadClient()
    const result = await jira.connect({ ...CREDENTIAL, email: '' })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cloud ID') })
    expect(result).toMatchObject({ error: expect.stringContaining('HTTP 404') })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.authorization).toBeUndefined()
  })

  it('identifies a wrong base path returning HTML as a response problem', async () => {
    fixture = await startJiraAuthFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>Sign in</html>')
    })
    const jira = await loadClient()
    const result = await jira.connect(CREDENTIAL)
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('unexpected account response')
    })
    expect(result).toMatchObject({ error: expect.stringContaining('base path') })
    expect(fixture.requests).toHaveLength(1)
  })

  it.each(['..', 'cloud/other', 'cloud%2fother', '', 'cloud?token=private-token'])(
    'refuses malformed cloud ID %s before sending credentials to the gateway',
    async (cloudId) => {
      fixture = await startJiraAuthFixture((_request, response) => {
        jiraFixtureJson(response, 200, { cloudId })
      })
      const jira = await loadClient()
      await expect(jira.connect({ ...CREDENTIAL, email: '' })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('cloud ID')
      })
      expect(fixture.requests).toHaveLength(1)
    }
  )

  it('never probes the Cloud gateway for self-hosted credentials or a server outage', async () => {
    fixture = await startJiraAuthFixture((_request, response) => {
      jiraFixtureJson(response, 401, {})
    })
    const jira = await loadClient()
    await jira.connect({ ...CREDENTIAL, authType: 'server' })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.url).toBe(`${SITE}/rest/api/2/myself`)
    await fixture.close()
    fixture = await startJiraAuthFixture((_request, response) => {
      jiraFixtureJson(response, 503, {})
    })
    await jira.connect(CREDENTIAL)
    expect(fixture.requests).toHaveLength(1)
  })

  it('keeps legacy stored sites while refusing edited gateway destinations', async () => {
    const dir = join(tempHome, '.orca')
    mkdirSync(join(dir, 'jira-tokens'), { recursive: true })
    const sites = [
      { id: 'legacy' },
      { id: 'scoped', apiBaseUrl: GATEWAY },
      { id: 'foreign', apiBaseUrl: 'https://evil.example/ex/jira/cloud-abc' },
      { id: 'wrong-path', apiBaseUrl: `${GATEWAY}/../other-cloud` },
      { id: 'query', apiBaseUrl: `${GATEWAY}?token=private-token` }
    ].map((site) => ({
      siteUrl: SITE,
      email: 'ada@example.com',
      displayName: 'Ada',
      accountId: 'account-alpha',
      ...site
    }))
    writeFileSync(join(dir, 'jira-sites.json'), JSON.stringify({ version: 1, sites }))
    for (const site of sites) {
      writeFileSync(
        join(dir, 'jira-tokens', `${Buffer.from(site.id).toString('base64url')}.enc`),
        'private-token'
      )
    }
    const jira = await loadClient()
    expect(jira.getStatus().sites?.map((site) => site.id)).toEqual(['legacy', 'scoped'])
    expect(jira.getClients()[0]?.site.authType).toBe('cloud')
  })
})
