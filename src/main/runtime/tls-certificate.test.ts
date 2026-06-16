import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadOrCreateTlsCertificate } from './tls-certificate'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-tls-certificate-test-'))
  tempRoots.push(root)
  return root
}

describe('loadOrCreateTlsCertificate', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('generates certificates without requiring an openssl executable', () => {
    const root = makeTempRoot()
    const result = loadOrCreateTlsCertificate(root)

    expect(result.cert).toContain('-----BEGIN CERTIFICATE-----')
    expect(result.key).toContain('-----BEGIN PRIVATE KEY-----')
    expect(result.fingerprint).toMatch(/^sha256:/)
    expect(existsSync(join(root, 'orca-tls-cert.pem'))).toBe(true)
    expect(existsSync(join(root, 'orca-tls-key.pem'))).toBe(true)
  })
})
