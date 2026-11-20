import { afterEach, expect, it, vi } from 'vitest'
import { acquireAzureCliAccessToken } from './azure-cli-access-token'
import {
  installAzureDevOpsAuthSource,
  invalidateAzureDevOpsCredentials,
  resolveAzureDevOpsCredentials
} from './azure-devops-credentials'
import type { AzureDevOpsAuthMethod } from '../../shared/source-control/azure-devops-auth-types'

vi.mock('./azure-cli-access-token', { spy: true })

afterEach(() => {
  installAzureDevOpsAuthSource(null)()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('refreshes near expiry and invalidates a rejected generation without dropping its replacement', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.mocked(acquireAzureCliAccessToken)
    .mockResolvedValueOnce({ accessToken: 'first', expiresAtMs: 1_600_000 })
    .mockResolvedValueOnce({ accessToken: 'second', expiresAtMs: 2_000_000 })
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: 'azure-cli' }) })

  const [first, concurrent] = await Promise.all([
    resolveAzureDevOpsCredentials(),
    resolveAzureDevOpsCredentials()
  ])
  expect(first.headers.Authorization).toBe('Bearer first')
  expect(concurrent.headers.Authorization).toBe('Bearer first')
  vi.setSystemTime(1_300_000)
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer second' }
  })
  if (first.method !== 'azure-cli') {
    throw new Error('Expected Azure CLI credentials')
  }
  invalidateAzureDevOpsCredentials({ generation: first.generation })
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer second' }
  })
})

it('does not publish a pending CLI token after switching to environment credentials', async () => {
  const pending = Promise.withResolvers<{ accessToken: string; expiresAtMs: number }>()
  vi.mocked(acquireAzureCliAccessToken)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ accessToken: 'fresh', expiresAtMs: Date.now() + 600_000 })
  vi.stubEnv('ORCA_AZURE_DEVOPS_ACCESS_TOKEN', 'environment-token')
  let method: AzureDevOpsAuthMethod = 'azure-cli'
  installAzureDevOpsAuthSource({ getSettings: () => ({ azureDevOpsAuthMethod: method }) })

  const read = resolveAzureDevOpsCredentials()
  method = 'environment'
  invalidateAzureDevOpsCredentials()
  pending.resolve({ accessToken: 'obsolete', expiresAtMs: Date.now() + 600_000 })
  await expect(read).resolves.toMatchObject({
    headers: { Authorization: 'Bearer environment-token' }
  })
  method = 'azure-cli'
  await expect(resolveAzureDevOpsCredentials()).resolves.toMatchObject({
    headers: { Authorization: 'Bearer fresh' }
  })
})
