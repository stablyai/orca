import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireAzureCliAccessToken, AzureDevOpsAuthError } from './azure-cli-access-token'
import { requestAzureDevOpsJsonAtBase } from './azure-devops-api-request'
import { installAzureDevOpsAuthSource } from './azure-devops-credentials'
import { getAzureDevOpsAuthStatus } from './client'
import { createAzureDevOpsPullRequest } from './pull-request-creation'

vi.mock('./azure-cli-access-token', { spy: true })
vi.mock('./repository-ref', () => ({
  getAzureDevOpsRepoRef: async () => ({
    host: 'dev.azure.com',
    project: 'Project',
    repository: 'repo',
    apiBaseUrl: 'https://dev.azure.com/acme/Project',
    webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
  })
}))

const base = 'https://dev.azure.com/acme/Project'
const pull = '/_apis/git/repositories/repo/pullRequests'
const input = { provider: 'azure-devops', title: 'Review', base: 'main', head: 'feature' } as const
const expiresAtMs = Date.parse('2026-01-01T00:10:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: 'azure-cli' }) })
  vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', undefined)
  vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'ignored-pat')
  vi.mocked(acquireAzureCliAccessToken).mockResolvedValue({
    accessToken: 'cli-token-a',
    expiresAtMs
  })
})

afterEach(() => {
  vi.useRealTimers()
  installAzureDevOpsAuthSource(null)()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('uses the CLI identity for REST reads and creation even with an environment PAT', async () => {
  const requests: Record<string, string | null> = {}
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    requests[init.method ?? 'GET'] = new Headers(init.headers).get('authorization')
    return Response.json({ pullRequestId: 31, title: 'Review' })
  })
  await expect(requestAzureDevOpsJsonAtBase(base, `${pull}/31`)).resolves.toMatchObject({
    pullRequestId: 31
  })
  await expect(createAzureDevOpsPullRequest('unused', input, 'local')).resolves.toMatchObject({
    ok: true,
    number: 31
  })
  expect(requests).toEqual({ GET: 'Bearer cli-token-a', POST: 'Bearer cli-token-a' })
})

it('rejects a custom destination without sending an authenticated request', async () => {
  const fetchRequest = vi.fn(async () => Response.json({ pullRequestId: 31 }))
  vi.stubGlobal('fetch', fetchRequest)

  await expect(
    requestAzureDevOpsJsonAtBase('https://dev.azure.com.example.test', pull, {}, true)
  ).rejects.toMatchObject({ code: 'unsupported-endpoint' })
  expect(fetchRequest).not.toHaveBeenCalled()
})

it('retains the CLI identity when a legacy cloud organization negotiates an older API version', async () => {
  const legacyBase = 'https://bounded.visualstudio.com/Project'
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (new Headers(init.headers).get('authorization') !== 'Bearer cli-token-a') {
      return new Response(null, { status: 403 })
    }
    return url.searchParams.get('api-version') === '5.1'
      ? Response.json({ pullRequestId: 31 })
      : Response.json({ typeKey: 'VssVersionOutOfRangeException' }, { status: 400 })
  })
  await expect(requestAzureDevOpsJsonAtBase(legacyBase, pull, {}, true)).resolves.toEqual({
    pullRequestId: 31
  })
})

it('refreshes a GET after an explicit HTTP 401', async () => {
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'rejected', expiresAtMs })
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs })
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) =>
    new Headers(init.headers).get('authorization') === 'Bearer fresh'
      ? Response.json({ pullRequestId: 31 })
      : new Response(null, { status: 401 })
  )
  await expect(requestAzureDevOpsJsonAtBase(base, pull, {}, true)).resolves.toEqual({
    pullRequestId: 31
  })
})

it('does not replay a rejected creation, but lets the next attempt use a fresh credential', async () => {
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'rejected', expiresAtMs })
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs })
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) =>
    new Headers(init.headers).get('authorization') === 'Bearer fresh'
      ? Response.json({ pullRequestId: 31, title: 'Review' })
      : new Response(null, { status: 401 })
  )
  await expect(createAzureDevOpsPullRequest('unused', input, 'local')).resolves.toMatchObject({
    ok: false,
    code: 'auth_required'
  })
  await expect(createAzureDevOpsPullRequest('unused', input, 'local')).resolves.toMatchObject({
    ok: true,
    number: 31
  })
})

it('distinguishes a CLI token from verified organization access', async () => {
  await expect(getAzureDevOpsAuthStatus()).resolves.toMatchObject({
    authMethod: 'azure-cli',
    credentialState: 'credential-ready',
    credentialAvailable: true,
    authenticated: false
  })
  vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', base)
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (
      url.origin !== 'https://dev.azure.com' ||
      url.pathname !== '/acme/Project/_apis/connectionData' ||
      new Headers(init.headers).get('authorization') !== 'Bearer cli-token-a'
    ) {
      return new Response(null, { status: 404 })
    }
    return Response.json({ authenticatedUser: { uniqueName: 'ada@example.test' } })
  })
  const status = await getAzureDevOpsAuthStatus()
  expect(status).toMatchObject({
    credentialState: 'authenticated',
    authenticated: true,
    account: 'ada@example.test'
  })
  expect(JSON.stringify(status)).not.toContain('cli-token-a')
  vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }))
  await expect(getAzureDevOpsAuthStatus()).resolves.toMatchObject({
    credentialState: 'error',
    errorCode: 'forbidden',
    authenticated: false
  })
})

it('surfaces a CLI login failure instead of falling back to the environment PAT', async () => {
  vi.mocked(acquireAzureCliAccessToken).mockRejectedValue(
    new AzureDevOpsAuthError('login-required')
  )
  const fetchRequest = vi.fn(async () => Response.json({ pullRequestId: 31, title: 'Review' }))
  vi.stubGlobal('fetch', fetchRequest)
  await expect(getAzureDevOpsAuthStatus()).resolves.toMatchObject({
    credentialState: 'error',
    errorCode: 'login-required',
    credentialAvailable: false,
    authenticated: false
  })
  await expect(createAzureDevOpsPullRequest('unused', input, 'local')).resolves.toMatchObject({
    ok: false,
    code: 'auth_required'
  })
  expect(fetchRequest).not.toHaveBeenCalled()
})
