import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAzureDevOpsPreviewApiVersionCache,
  requestAzureDevOpsJson,
  requestAzureDevOpsJsonAtBase,
  requestAzureDevOpsResponseAtBase
} from './azure-devops-api-request'
import type { AzureDevOpsRepoRef } from './repository-ref'

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
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('retries with -preview when Azure DevOps Server rejects the api-version', async () => {
    const versions: (string | null)[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      versions.push(url.searchParams.get('api-version'))
      if (!url.searchParams.get('api-version')?.endsWith('-preview')) {
        return previewRejection()
      }
      return Response.json({ authenticatedUser: { providerDisplayName: 'Server User' } })
    }) as never

    await expect(
      requestAzureDevOpsJsonAtBase(SERVER_BASE, '/_apis/connectionData')
    ).resolves.toEqual({ authenticatedUser: { providerDisplayName: 'Server User' } })
    expect(versions).toEqual(['7.1', '7.1-preview'])
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
    // First request learns the suffix; the second must not repeat the 400 round trip.
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
    // Collection-level env base must not strip the project segment Git endpoints need.
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

describe('non-GET requests', () => {
  it('sends the body and content type, and retries a PATCH with -preview', async () => {
    _resetAzureDevOpsPreviewApiVersionCache()
    const calls: { url: string; init: RequestInit }[] = []
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1) {
        return new Response(JSON.stringify({ typeKey: 'VssInvalidPreviewVersionException' }), {
          status: 400
        })
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestAzureDevOpsJsonAtBase<{ id: number }>(
      'https://ado.example/tfs/DefaultCollection',
      '/_apis/wit/workitems/1',
      {
        method: 'PATCH',
        body: [{ op: 'add', path: '/fields/System.Title', value: 'New' }],
        contentType: 'application/json-patch+json'
      }
    )

    expect(result).toEqual({ id: 1 })
    expect(calls).toHaveLength(2)
    expect(calls[0].init.method).toBe('PATCH')
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json-patch+json'
    })
    expect(calls[1].url).toContain('api-version=7.1-preview')
    // The retry must still carry the original method and payload, not a bare
    // GET-shaped follow-up that happens to hit the right URL.
    expect(calls[1].init.method).toBe('PATCH')
    expect(calls[1].init.body).toBe(calls[0].init.body)
    expect(calls[1].init.body).toBe(
      JSON.stringify([{ op: 'add', path: '/fields/System.Title', value: 'New' }])
    )
  })
})

describe('requestAzureDevOpsResponseAtBase', () => {
  it('preserves the upstream status instead of collapsing it', async () => {
    _resetAzureDevOpsPreviewApiVersionCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'gone' }), { status: 404 }))
    )

    const result = await requestAzureDevOpsResponseAtBase(
      'https://dev.azure.com/org',
      '/_apis/wit/workitems/1'
    )

    expect(result).toEqual({ status: 404, body: { message: 'gone' } })
  })

  it('returns a 200 body without throwing', async () => {
    _resetAzureDevOpsPreviewApiVersionCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ count: 2 }), { status: 200 }))
    )

    const result = await requestAzureDevOpsResponseAtBase(
      'https://dev.azure.com/org',
      '/_apis/projects'
    )

    expect(result).toEqual({ status: 200, body: { count: 2 } })
  })
})

describe('requestAzureDevOpsResponseAtBase and the preview-version probe', () => {
  beforeEach(() => {
    _resetAzureDevOpsPreviewApiVersionCache()
  })
  afterEach(() => {
    globalThis.fetch = OLD_FETCH
    process.env = OLD_ENV
  })

  it('hands back a 400 the preview probe rejected, body intact', async () => {
    // The probe reads the body to look for VssInvalidPreviewVersionException.
    // Reading the original would leave nothing for the caller, and the Boards
    // proxy would report an opaque 503 instead of Azure's validation message.
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'token' }
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(
          JSON.stringify({ typeKey: 'RuleValidationException', message: 'TF51011: no such path' }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    )

    const result = await requestAzureDevOpsResponseAtBase(SERVER_BASE, '/_apis/wit/wiql', {
      method: 'POST',
      body: { query: 'SELECT [System.Id] FROM WorkItems' }
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ message: 'TF51011: no such path' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('redirect handling', () => {
  afterEach(() => {
    globalThis.fetch = OLD_FETCH
    process.env = OLD_ENV
  })

  it('refuses to follow a redirect rather than carrying the credential to an unchecked path', async () => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'token' }
    let seen: RequestInit | undefined
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await requestAzureDevOpsResponseAtBase(SERVER_BASE, '/_apis/wit/workitems')

    expect(seen?.redirect).toBe('error')
  })
})
