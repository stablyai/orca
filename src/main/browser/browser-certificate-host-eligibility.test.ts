import { describe, expect, it, vi } from 'vitest'

import { isEligibleResolvedLocalCertificateHost } from './browser-certificate-host-eligibility'

describe('isEligibleResolvedLocalCertificateHost', () => {
  it('accepts canonical loopback hosts without a DNS lookup', async () => {
    const resolveProxy = vi.fn()
    const lookupAddresses = vi.fn()

    await expect(
      isEligibleResolvedLocalCertificateHost(
        'localhost',
        'https://localhost:3443/',
        resolveProxy,
        lookupAddresses
      )
    ).resolves.toBe(true)
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(lookupAddresses).not.toHaveBeenCalled()
  })

  it('accepts a custom hostname only when every address resolves to loopback', async () => {
    const lookupAddresses = vi.fn(async () => [{ address: '127.0.0.1' }, { address: '::1' }])

    await expect(
      isEligibleResolvedLocalCertificateHost(
        'localhost.bswhealth.com',
        'https://localhost.bswhealth.com:44302/',
        vi.fn(async () => 'DIRECT'),
        lookupAddresses
      )
    ).resolves.toBe(true)
    expect(lookupAddresses).toHaveBeenCalledWith('localhost.bswhealth.com', {
      all: true,
      verbatim: true
    })
  })

  it('rejects public, mixed, empty, and failed DNS results', async () => {
    await expect(
      isEligibleResolvedLocalCertificateHost(
        'example.com',
        'https://example.com/',
        vi.fn(async () => 'DIRECT'),
        vi.fn(async () => [{ address: '203.0.113.10' }])
      )
    ).resolves.toBe(false)
    await expect(
      isEligibleResolvedLocalCertificateHost(
        'mixed.example',
        'https://mixed.example/',
        vi.fn(async () => 'DIRECT'),
        vi.fn(async () => [{ address: '127.0.0.1' }, { address: '203.0.113.10' }])
      )
    ).resolves.toBe(false)
    await expect(
      isEligibleResolvedLocalCertificateHost(
        'empty.example',
        'https://empty.example/',
        vi.fn(async () => 'DIRECT'),
        vi.fn(async () => [])
      )
    ).resolves.toBe(false)
    await expect(
      isEligibleResolvedLocalCertificateHost(
        'missing.example',
        'https://missing.example/',
        vi.fn(async () => 'DIRECT'),
        vi.fn(async () => {
          throw new Error('not found')
        })
      )
    ).resolves.toBe(false)
  })

  it('rejects a loopback-resolving hostname when Chromium uses a proxy', async () => {
    const lookupAddresses = vi.fn(async () => [{ address: '127.0.0.1' }])

    await expect(
      isEligibleResolvedLocalCertificateHost(
        'local.example',
        'https://local.example:3443/',
        vi.fn(async () => 'PROXY proxy.example:8080; DIRECT'),
        lookupAddresses
      )
    ).resolves.toBe(false)
    expect(lookupAddresses).not.toHaveBeenCalled()
  })
})
