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

beforeEach(() => {
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: 'azure-cli' }) })
  vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', undefined)
  vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'ignored-pat')
  vi.mocked(acquireAzureCliAccessToken).mockResolvedValue({
    accessToken: 'cli-token-a',
    expiresAtMs: Date.now() + 600_000
  })
})

afterEach(() => {
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
  vi.mocked(acquireAzureCliAccessToken).mockRejectedValue(
    new AzureDevOpsAuthError('login-required')
  )
  vi.stubGlobal('fetch', () => {
    throw new Error('unexpected network request')
  })

  await expect(
    requestAzureDevOpsJsonAtBase('https://dev.azure.com.example.test', pull, {}, true)
  ).rejects.toMatchObject({ code: 'unsupported-endpoint' })
})

it('preserves API version negotiation for a legacy cloud organization', async () => {
  const legacyBase = 'https://bounded.visualstudio.com/Project'
  vi.stubGlobal('fetch', async (url: URL) =>
    url.searchParams.get('api-version') === '5.1'
      ? Response.json({ pullRequestId: 31 })
      : Response.json({ typeKey: 'VssVersionOutOfRangeException' }, { status: 400 })
  )
  await expect(requestAzureDevOpsJsonAtBase(legacyBase, pull, {}, true)).resolves.toEqual({
    pullRequestId: 31
  })
})

it('refreshes a GET after an explicit HTTP 401', async () => {
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'rejected', expiresAtMs: Date.now() + 600_000 })
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs: Date.now() + 600_000 })
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
    .mockResolvedValueOnce({ accessToken: 'rejected', expiresAtMs: Date.now() + 600_000 })
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs: Date.now() + 600_000 })
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
  vi.stubGlobal('fetch', async () =>
    Response.json({ authenticatedUser: { uniqueName: 'ada@example.test' } })
  )
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
})
