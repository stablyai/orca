import { describe, expect, it } from 'vitest'
import {
  allowsArtifactCloudAuthOverride,
  resolveArtifactCloudApiUrl
} from './artifact-cloud-config'

describe('resolveArtifactCloudApiUrl', () => {
  it('allows loopback HTTP only in development', () => {
    expect(
      resolveArtifactCloudApiUrl(
        undefined,
        { ORCA_ARTIFACTS_API_URL: 'http://127.0.0.1:45961' },
        false
      )
    ).toBe('http://127.0.0.1:45961')
    expect(() => resolveArtifactCloudApiUrl('http://127.0.0.1:45961', {}, true)).toThrow(/HTTPS/)
  })

  it('rejects origins that could receive an Orca access token', () => {
    expect(() => resolveArtifactCloudApiUrl('https://example.com', {}, false)).toThrow(
      /onorca\.dev/
    )
    expect(() => resolveArtifactCloudApiUrl('https://share.onorca.dev/path', {}, false)).toThrow(
      /origin/
    )
  })

  it('allows both first-party domain families without trusting similar hostnames', () => {
    for (const origin of ['https://share.onorca.dev', 'https://share.orca.dev']) {
      expect(resolveArtifactCloudApiUrl(origin, {}, true)).toBe(origin)
    }
    for (const origin of [
      'https://share.orca.dev.example.com',
      'https://notorca.dev',
      'https://notonorca.dev',
      'https://share.onorca.dev.example.com'
    ]) {
      expect(() => resolveArtifactCloudApiUrl(origin, {}, true)).toThrow()
    }
  })

  it('allows auth token overrides only in non-production development builds', () => {
    expect(allowsArtifactCloudAuthOverride({}, false)).toBe(true)
    expect(allowsArtifactCloudAuthOverride({ NODE_ENV: 'production' }, false)).toBe(false)
    expect(allowsArtifactCloudAuthOverride({}, true)).toBe(false)
  })
})
