import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAzCliAccessTokenCacheForTests } from './az-cli-access-token'
import {
  _resetAzureDevOpsApiVersionCache,
  requestAzureDevOpsJsonAtBase
} from './azure-devops-api-request'

const runAzAccessTokenCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./az-cli-invocation', () => ({
  runAzAccessTokenCommand: runAzAccessTokenCommandMock
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

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

describe('requestAzureDevOpsJsonAtBase auth resolution', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_PAT
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_USERNAME
    runAzAccessTokenCommandMock.mockReset()
    _resetAzureDevOpsApiVersionCache()
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
})
