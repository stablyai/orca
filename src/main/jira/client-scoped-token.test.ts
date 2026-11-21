import { mkdtempSync, rmSync } from 'node:fs'
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
  it('connects an email-free scoped token and routes requests through its tenant', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url === `${SITE}/_edge/tenant_info`) {
        jiraFixtureJson(response, 200, { cloudId: 'cloud-abc' })
      } else if (request.url === `${GATEWAY}/rest/api/3/myself`) {
        jiraFixtureJson(response, 200, VIEWER)
      } else if (request.url.startsWith(`${GATEWAY}/rest/api/3/`)) {
        jiraFixtureJson(response, 200, { issues: [] })
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
    const client = (await jira.getClients())[0]
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

  it('never pairs a reconnected token with the site record it replaces', async () => {
    fixture = await startJiraAuthFixture((request, response) => {
      if (request.url === `${SITE}/rest/api/3/myself`) {
        jiraFixtureJson(response, 200, VIEWER)
      } else {
        jiraFixtureJson(response, 401, {})
      }
    })
    const jira = await loadClient()
    await expect(
      jira.connect({ ...CREDENTIAL, apiToken: 'unscoped-token' })
    ).resolves.toMatchObject({
      ok: true
    })
    const store = await import('./site-credential-store')
    const file = await store.getSiteFile()
    const site = file.sites[0]
    if (!site) {
      throw new Error('Expected the connected Jira site')
    }

    // Same steps as connect(): token first, then the site record, under the registry queue.
    let reader: ReturnType<typeof jira.getClients> = Promise.resolve([])
    await store.inSiteRegistryOrder(async () => {
      await store.saveToken(site.id, 'scoped-token')
      reader = jira.getClients()
      await store.writeSiteFile({ ...file, sites: [{ ...site, apiBaseUrl: GATEWAY }] })
    })

    const [client] = await reader
    expect(client?.site.apiBaseUrl).toBe(GATEWAY)
    expect(client?.authorization).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:scoped-token`).toString('base64')}`
    )
  })
})
