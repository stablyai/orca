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
})
