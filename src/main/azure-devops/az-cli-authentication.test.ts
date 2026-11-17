import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteUrlProbe from '../git/remotes/remote-url-probe'
import { getAzureDevOpsAuthStatus } from './client'
import { isAzureDevOpsReviewCreationAuthenticated } from './pull-request-creation'
import { _resetAzureDevOpsApiVersionCache } from './azure-devops-api-request'
import { _resetAzCliAccessTokenCacheForTests } from './az-cli-access-token'
import { _resetAzureDevOpsRepoRefCache } from './repository-ref'

const { readRemoteUrlMock, runAzAccessTokenCommandMock } = vi.hoisted(() => ({
  readRemoteUrlMock: vi.fn(),
  runAzAccessTokenCommandMock: vi.fn()
}))

// Why: the repo ref probes the remote through this module; keep its error classifier real
// so the probe cache still distinguishes a transient failure from a missing remote.
vi.mock('../git/remotes/remote-url-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteUrlProbe>()),
  readRemoteUrl: readRemoteUrlMock
}))

vi.mock('./az-cli-invocation', () => ({
  runAzAccessTokenCommand: runAzAccessTokenCommandMock
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => 'Template body')
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

beforeEach(() => {
  process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
  delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  readRemoteUrlMock.mockReset()
  readRemoteUrlMock.mockResolvedValue('https://dev.azure.com/acme/Project/_git/repo\n')
  runAzAccessTokenCommandMock.mockReset()
  runAzAccessTokenCommandMock.mockRejectedValue(new Error('az not available'))
  _resetAzureDevOpsRepoRefCache()
  _resetAzureDevOpsApiVersionCache()
  _resetAzCliAccessTokenCacheForTests()
})

afterEach(() => {
  process.env = OLD_ENV
  globalThis.fetch = OLD_FETCH
  _resetAzureDevOpsRepoRefCache()
})

describe('auth status without an environment token', () => {
  it('marks an az CLI login as configured when no env token or base URL is set', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({ accessToken: 'entra-jwt', expires_on: 32472144000 })
    )
    await expect(getAzureDevOpsAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    })
  })

  it('stays not configured when neither env tokens nor an az login exist', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    await expect(getAzureDevOpsAuthStatus()).resolves.toMatchObject({
      configured: false,
      authenticated: false
    })
  })
})

describe('review creation authentication', () => {
  it('treats a configured token as sufficient authentication', async () => {
    await expect(isAzureDevOpsReviewCreationAuthenticated('/repo')).resolves.toBe(true)
  })

  it('recognizes an az CLI login as authentication for hosted Azure DevOps repos', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({ accessToken: 'entra-jwt', expires_on: 32472144000 })
    )

    await expect(isAzureDevOpsReviewCreationAuthenticated('/repo')).resolves.toBe(true)
  })

  it('stays unauthenticated without a token when az has no login', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN

    await expect(isAzureDevOpsReviewCreationAuthenticated('/repo')).resolves.toBe(false)
  })

  it('requires a token for on-prem base URLs instead of consulting az', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://tfs.corp.example/tfs/Collection'

    await expect(isAzureDevOpsReviewCreationAuthenticated('/repo')).resolves.toBe(false)
    expect(runAzAccessTokenCommandMock).not.toHaveBeenCalled()
  })
})
