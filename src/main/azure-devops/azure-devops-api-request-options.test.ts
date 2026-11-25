import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const SERVER_BASE = 'https://ado.example.com:8443/tfs/MyCollection'

describe('a call that pins its own api-version', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    _resetAzureDevOpsApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    _resetAzureDevOpsApiVersionCache()
  })

  it('keeps the pinned version and does not negotiate it away', async () => {
    const versions: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        versions.push(new URL(String(input)).searchParams.get('api-version'))
        return Response.json({ typeKey: 'VssVersionOutOfRangeException' }, { status: 400 })
      })
    )

    await expect(
      requestAzureDevOpsJsonAtBase(SERVER_BASE, '/_apis/Settings/WebTeam/team-1/Entries/me', {
        searchParams: { 'api-version': '7.1-preview.1' }
      })
    ).resolves.toBeNull()
    // The endpoint exists only at that version, so stepping down would just fail differently.
    expect(versions).toEqual(['7.1-preview.1'])
  })
})

describe('a call that supplies a request body', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    _resetAzureDevOpsApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
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
