import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireAzureCliAccessToken } from './azure-cli-access-token'
import {
  installAzureDevOpsAuthSource,
  invalidateAzureDevOpsCredentials,
  resolveAzureDevOpsCredentials
} from './azure-devops-credentials'
import type { AzureDevOpsAuthMethod } from '../../shared/source-control/azure-devops-auth-types'

vi.mock('./azure-cli-access-token', { spy: true })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  installAzureDevOpsAuthSource(null)()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('reuses the CLI token until it reaches the refresh window', async () => {
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'first', expiresAtMs: 1_600_000 })
    .mockResolvedValueOnce({ accessToken: 'second', expiresAtMs: 2_000_000 })
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: 'azure-cli' }) })

  const first = { headers: { Authorization: 'Bearer first' } }
  await expect(
    Promise.all([resolveAzureDevOpsCredentials(), resolveAzureDevOpsCredentials()])
  ).resolves.toMatchObject([first, first])
  vi.setSystemTime(1_299_999)
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject(first)
  vi.setSystemTime(1_300_000)
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer second' }
  })
})

it('does not drop the replacement for a late rejection of an old credential', async () => {
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'first', expiresAtMs: 1_600_000 })
    .mockResolvedValueOnce({ accessToken: 'second', expiresAtMs: 2_000_000 })
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: 'azure-cli' }) })

  const first = await resolveAzureDevOpsCredentials()
  if (first.method !== 'azure-cli') {
    throw new Error('Expected Azure CLI credentials')
  }
  invalidateAzureDevOpsCredentials({ generation: first.generation })
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer second' }
  })
  invalidateAzureDevOpsCredentials({ generation: first.generation })
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer second' }
  })
})

it('does not publish a pending CLI token after switching to environment credentials', async () => {
  const pending = Promise.withResolvers<{ accessToken: string; expiresAtMs: number }>()
  vi.mocked(acquireAzureCliAccessToken)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs: 1_600_000 })
  vi.stubEnv('ORCA_AZURE_DEVOPS_ACCESS_TOKEN', 'environment-token')
  let method: AzureDevOpsAuthMethod = 'azure-cli'
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: method }) })

  const read = resolveAzureDevOpsCredentials()
  method = 'environment'
  invalidateAzureDevOpsCredentials()
  pending.resolve({ accessToken: 'obsolete', expiresAtMs: 1_600_000 })
  await expect(read).resolves.toMatchObject({
    headers: { Authorization: 'Bearer environment-token' }
  })
  method = 'azure-cli'
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer fresh' }
  })
})
