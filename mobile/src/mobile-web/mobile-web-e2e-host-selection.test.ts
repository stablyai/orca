import { describe, expect, it } from 'vitest'
import { mobileWebE2eHostId } from './mobile-web-e2e-host-selection'

const hosts = [
  { id: 'old-host', publicKeyB64: 'old-key' },
  { id: 'paired-host', publicKeyB64: 'paired-key' }
]

describe('mobile WebView E2E host selection', () => {
  it('resolves only the host with the injected pairing public key', () => {
    expect(mobileWebE2eHostId(hosts, 'paired-key')).toBe('paired-host')
    expect(mobileWebE2eHostId(hosts, 'missing-key')).toBeUndefined()
    expect(mobileWebE2eHostId(hosts, undefined)).toBeUndefined()
  })
})
