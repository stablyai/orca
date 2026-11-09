import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudDevSigningAllowed, withCloudBuildDefaults } from './cloud-build-defaults'

describe('withCloudBuildDefaults', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves env untouched when the build defines no defaults', () => {
    expect(withCloudBuildDefaults({ ORCA_BILLING_API_URL: 'https://b.example' })).toMatchObject({
      ORCA_BILLING_API_URL: 'https://b.example',
      ORCA_CLOUD_SANDBOX_URL: undefined
    })
  })

  it('fills unset URLs from the build and keeps run-time overrides', () => {
    vi.stubGlobal('ORCA_CLOUD_BUILD_DEFAULTS', {
      billingApiUrl: 'https://billing.dev.example',
      cloudSandboxUrl: 'https://sandbox.dev.example'
    })
    expect(
      withCloudBuildDefaults({ ORCA_CLOUD_SANDBOX_URL: 'https://override.example' })
    ).toMatchObject({
      ORCA_BILLING_API_URL: 'https://billing.dev.example',
      ORCA_CLOUD_SANDBOX_URL: 'https://override.example'
    })
  })

  it('allows dev signing in packaged builds only when the build opts in', () => {
    expect(cloudDevSigningAllowed(false)).toBe(true)
    expect(cloudDevSigningAllowed(true)).toBe(false)
    vi.stubGlobal('ORCA_CLOUD_BUILD_DEFAULTS', { allowDevSigning: true })
    expect(cloudDevSigningAllowed(true)).toBe(true)
  })
})
