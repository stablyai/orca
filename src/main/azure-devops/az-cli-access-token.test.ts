import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAzCliAccessTokenCacheForTests,
  getAzCliAzureDevOpsAccessToken,
  isEntraEligibleAzureDevOpsBaseUrl
} from './az-cli-access-token'

const runAzAccessTokenCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./az-cli-invocation', () => ({
  runAzAccessTokenCommand: runAzAccessTokenCommandMock
}))

describe('getAzCliAzureDevOpsAccessToken', () => {
  beforeEach(() => {
    runAzAccessTokenCommandMock.mockReset()
    _resetAzCliAccessTokenCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the access token acquired for the Azure DevOps resource', async () => {
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({
        accessToken: 'entra-jwt',
        expiresOn: '2999-01-01 00:00:00.000000',
        expires_on: 32472144000,
        subscription: 'sub',
        tenant: 'tenant',
        tokenType: 'Bearer'
      })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('entra-jwt')
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledWith(
      '499b84ac-1321-427f-aa17-267ca6975798'
    )
  })

  it('reuses the cached token until expiry so polling does not respawn az', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00Z'))
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({
        accessToken: 'cached-jwt',
        expires_on: Date.parse('2026-08-03T01:00:00Z') / 1000
      })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('cached-jwt')
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('cached-jwt')
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledTimes(1)
  })

  it('re-acquires a token once the cached one nears expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00Z'))
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'first-jwt',
        expires_on: Date.parse('2026-08-03T01:00:00Z') / 1000
      })
    )
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'second-jwt',
        expires_on: Date.parse('2026-08-03T02:00:00Z') / 1000
      })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('first-jwt')
    // Why: inside the 5-minute expiry margin the token must not be served stale.
    vi.setSystemTime(new Date('2026-08-03T00:56:00Z'))
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('second-jwt')
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when az is unavailable or not logged in', async () => {
    runAzAccessTokenCommandMock.mockRejectedValue(new Error('spawn az ENOENT'))

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBeNull()
  })

  it('does not respawn az on every call right after a failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00Z'))
    runAzAccessTokenCommandMock.mockRejectedValue(new Error('Please run "az login"'))

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBeNull()
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBeNull()
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledTimes(1)

    // Why: after the cooldown a fresh az login must be picked up without restarting Orca.
    vi.setSystemTime(new Date('2026-08-03T00:01:01Z'))
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({
        accessToken: 'recovered-jwt',
        expires_on: Date.parse('2026-08-03T02:00:00Z') / 1000
      })
    )
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('recovered-jwt')
  })

  it('shares one az invocation across concurrent callers', async () => {
    let resolveAz: (value: string) => void = () => {}
    runAzAccessTokenCommandMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveAz = resolve
      })
    )

    const first = getAzCliAzureDevOpsAccessToken()
    const second = getAzCliAzureDevOpsAccessToken()
    resolveAz(JSON.stringify({ accessToken: 'shared-jwt', expires_on: 32472144000 }))

    await expect(first).resolves.toBe('shared-jwt')
    await expect(second).resolves.toBe('shared-jwt')
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledTimes(1)
  })

  it('expires tokens from older az versions that only report a local-time expiresOn', async () => {
    vi.useFakeTimers()
    // Why: az's expiresOn has no timezone and Date.parse reads it as local
    // time, so the test clock uses the same zone-less form.
    vi.setSystemTime(new Date('2026-08-03T00:00:00'))
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'old-az-jwt', expiresOn: '2026-08-03 01:00:00.000000' })
    )
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'renewed-jwt', expiresOn: '2026-08-03 02:00:00.000000' })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('old-az-jwt')
    vi.setSystemTime(new Date('2026-08-03T00:56:00'))
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('renewed-jwt')
  })

  it('treats an already-expired token as a failure so the cooldown still applies', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00Z'))
    runAzAccessTokenCommandMock.mockResolvedValue(
      JSON.stringify({
        accessToken: 'stale-jwt',
        expires_on: Date.parse('2026-08-02T00:00:00Z') / 1000
      })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBeNull()
    // Why: without the cooldown every sequential poll would respawn az forever.
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBeNull()
    expect(runAzAccessTokenCommandMock).toHaveBeenCalledTimes(1)
  })

  it('caps the cache lifetime when az reports no parseable expiry at all', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00Z'))
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'unknown-expiry-jwt' })
    )
    runAzAccessTokenCommandMock.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'refetched-jwt' })
    )

    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('unknown-expiry-jwt')
    // Why: without an expiry a stale token would otherwise be served forever
    // and every request after Entra's ~1h lifetime would 401 until restart.
    vi.setSystemTime(new Date('2026-08-03T00:31:00Z'))
    await expect(getAzCliAzureDevOpsAccessToken()).resolves.toBe('refetched-jwt')
  })
})

describe('isEntraEligibleAzureDevOpsBaseUrl', () => {
  it('accepts the hosted Azure DevOps domains', () => {
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://dev.azure.com/acme')).toBe(true)
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://acme.visualstudio.com')).toBe(true)
  })

  it('rejects on-prem Azure DevOps Server hosts, which do not accept Entra tokens', () => {
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://tfs.corp.example/tfs/Collection')).toBe(false)
  })

  it('rejects lookalike hosts and malformed URLs', () => {
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://dev.azure.com.evil.example/acme')).toBe(false)
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://notvisualstudio.com')).toBe(false)
    expect(isEntraEligibleAzureDevOpsBaseUrl('not a url')).toBe(false)
  })

  it('rejects non-HTTPS URLs so a bearer token never travels in cleartext', () => {
    expect(isEntraEligibleAzureDevOpsBaseUrl('http://dev.azure.com/acme')).toBe(false)
  })

  it('rejects the bare visualstudio.com apex, which is not an Azure DevOps API host', () => {
    expect(isEntraEligibleAzureDevOpsBaseUrl('https://visualstudio.com')).toBe(false)
  })
})
