import { getCACertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  collectTrustedCaCertificates,
  dedupeCertificates,
  getLinearApiDispatcher
} from './linear-api-dispatcher'

describe('Linear API dispatcher', () => {
  it('trusts the OS store on top of the certificates Node would have used', () => {
    const trusted = new Set(collectTrustedCaCertificates())

    for (const certificate of getCACertificates('default')) {
      expect(trusted.has(certificate)).toBe(true)
    }
    for (const certificate of getCACertificates('system')) {
      expect(trusted.has(certificate)).toBe(true)
    }
  })

  it('drops certificates listed by more than one source', () => {
    const shared = '-----BEGIN CERTIFICATE-----shared-----END CERTIFICATE-----'
    const bundledOnly = '-----BEGIN CERTIFICATE-----bundled-----END CERTIFICATE-----'
    const systemOnly = '-----BEGIN CERTIFICATE-----system-----END CERTIFICATE-----'

    expect(
      dedupeCertificates([
        [shared, bundledOnly],
        [systemOnly, shared]
      ])
    ).toEqual([shared, bundledOnly, systemOnly])
  })

  it('reuses one agent so Linear requests keep pooling connections', () => {
    const dispatcher = getLinearApiDispatcher()

    expect(dispatcher).toBeDefined()
    expect(typeof dispatcher?.dispatch).toBe('function')
    expect(getLinearApiDispatcher()).toBe(dispatcher)
  })
})
