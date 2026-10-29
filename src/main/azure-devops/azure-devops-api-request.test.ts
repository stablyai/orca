import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAzCliAccessTokenCacheForTests } from './az-cli-access-token'
import {
  _resetAzureDevOpsPreviewApiVersionCache,
  azureDevOpsApiVersionForOrigin,
  markAzureDevOpsPreviewApiVersionOrigin,
  requestAzureDevOpsJson,
  requestAzureDevOpsJsonAtBase
} from './azure-devops-api-request'
import type { AzureDevOpsRepoRef } from './repository-ref'

const runAzAccessTokenCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./az-cli-invocation', () => ({
  runAzAccessTokenCommand: runAzAccessTokenCommandMock
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

const SERVER_BASE = 'https://ado.example.com:8443/tfs/MyCollection'

function previewRejection(): Response {
  return new Response(
    JSON.stringify({
      message:
        'The requested version "7.1" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests. For example: "7.1-preview"',
      typeKey: 'VssInvalidPreviewVersionException'
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  )
}

function serverRepoRef(): AzureDevOpsRepoRef {
  return {
    host: 'ado.example.com',
    organization: null,
    project: 'MyProject',
    repository: 'my-repo',
    apiBaseUrl: `${SERVER_BASE}/MyProject`,
    webBaseUrl: `${SERVER_BASE}/MyProject/_git/my-repo`
  }
}

describe('Azure DevOps API request (STA-3494)', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    runAzAccessTokenCommandMock.mockReset()
    runAzAccessTokenCommandMock.mockRejectedValue(new Error('az not available'))
    _resetAzureDevOpsPreviewApiVersionCache()
    _resetAzCliAccessTokenCacheForTests()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('remembers the -preview requirement per origin after the first rejection', async () => {
    const versions: (string | null)[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      versions.push(url.searchParams.get('api-version'))
      if (!url.searchParams.get('api-version')?.endsWith('-preview')) {
        return previewRejection()
      }
      return Response.json({ ok: true })
    }) as never

    const base = 'https://ado-sticky.example.com/tfs/MyCollection'
    await requestAzureDevOpsJsonAtBase(base, '/_apis/connectionData')
    await requestAzureDevOpsJsonAtBase(base, '/_apis/connectionData')
    expect(versions).toEqual(['7.1', '7.1-preview', '7.1-preview'])
  })

  it('does not retry a 400 that is not a preview-version rejection', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ message: 'A project name is required.' }, { status: 400 })
    )
    globalThis.fetch = fetchMock as never

    await expect(
      requestAzureDevOpsJsonAtBase(
        'https://ado-other.example.com/tfs/Coll',
        '/_apis/connectionData'
      )
    ).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the remote-derived project base for Git endpoints when the configured base shares its origin', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = SERVER_BASE
    const paths: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    expect(paths).toEqual(['/tfs/MyCollection/MyProject/_apis/git/repositories/my-repo'])
  })

  it('keeps a cross-origin configured base URL as an override for Git endpoints', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'http://127.0.0.1:8123/acme/Project'
    const origins: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      origins.push(new URL(String(input)).origin)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    expect(origins).toEqual(['http://127.0.0.1:8123'])
  })

  it('keeps a same-origin non-ancestor base URL as a Git endpoint override', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://ado.example.com:8443/rewrite/MyProject'
    const paths: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    expect(paths).toEqual(['/rewrite/MyProject/_apis/git/repositories/my-repo'])
  })
})

function fetchCapturingAuthorization(captured: (string | null)[]): typeof fetch {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements the call signature the code under test uses; vi.fn's return type lacks fetch's preconnect member.
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    captured.push(headers.get('Authorization'))
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
}

describe('azureDevOpsApiVersionForOrigin', () => {
  afterEach(() => _resetAzureDevOpsPreviewApiVersionCache())

  it('never double-suffixes a numbered preview version on a preview-only origin', () => {
    markAzureDevOpsPreviewApiVersionOrigin('https://ado.example.com')
    expect(azureDevOpsApiVersionForOrigin('https://ado.example.com', '7.1-preview.1')).toBe(
      '7.1-preview.1'
    )
    expect(azureDevOpsApiVersionForOrigin('https://ado.example.com', '7.1')).toBe('7.1-preview')
  })
})

describe('requestAzureDevOpsJsonAtBase auth resolution', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_PAT
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_USERNAME
    runAzAccessTokenCommandMock.mockReset()
    _resetAzureDevOpsPreviewApiVersionCache()
    _resetAzCliAccessTokenCacheForTests()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('falls back to the az CLI token for hosted Azure DevOps when no env token is set', async () => {
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({ accessToken: 'entra-jwt', expires_on: 32472144000 })
    )
    const captured: (string | null)[] = []
    globalThis.fetch = fetchCapturingAuthorization(captured)

    await requestAzureDevOpsJsonAtBase('https://dev.azure.com/acme/Project', '/_apis/projects')

    expect(captured).toEqual(['Bearer entra-jwt'])
  })

  it('never invokes az for on-prem Azure DevOps Server base URLs', async () => {
    const captured: (string | null)[] = []
    globalThis.fetch = fetchCapturingAuthorization(captured)

    await requestAzureDevOpsJsonAtBase('https://tfs.corp.example/tfs/Collection', '/_apis/projects')

    expect(runAzAccessTokenCommandMock).not.toHaveBeenCalled()
    expect(captured).toEqual([null])
  })

  it('prefers a configured env token over the az CLI', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'pat-token'
    const captured: (string | null)[] = []
    globalThis.fetch = fetchCapturingAuthorization(captured)

    await requestAzureDevOpsJsonAtBase('https://dev.azure.com/acme/Project', '/_apis/projects')

    expect(runAzAccessTokenCommandMock).not.toHaveBeenCalled()
    expect(captured).toEqual([`Basic ${Buffer.from(':pat-token').toString('base64')}`])
  })

  it('sends a JSON body with POST when the caller asks for it', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'pat-token'
    const calls: { method: string | undefined; contentType: string | null; body: string }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements the call signature the code under test uses; vi.fn's return type lacks fetch's preconnect member.
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        contentType: new Headers(init?.headers).get('Content-Type'),
        body: String(init?.body)
      })
      return Response.json({ workItemRelations: [] })
    }) as never

    await requestAzureDevOpsJsonAtBase('https://dev.azure.com/acme/Project', '/_apis/wit/wiql', {
      method: 'POST',
      body: { query: 'SELECT [System.Id] FROM WorkItems' }
    })

    expect(calls).toEqual([
      {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ query: 'SELECT [System.Id] FROM WorkItems' })
      }
    ])
  })
})
