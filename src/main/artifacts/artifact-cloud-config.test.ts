import { describe, expect, it } from 'vitest'
import { resolveArtifactCloudApiUrl } from './artifact-cloud-config'

describe('resolveArtifactCloudApiUrl', () => {
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
})
