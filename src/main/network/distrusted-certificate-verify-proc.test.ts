import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tls from 'node:tls'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ChainLink = { data: string; issuerCert?: ChainLink }
type VerifyProc = (
  request: { errorCode: number; certificate?: ChainLink; validatedCertificate?: ChainLink },
  callback: (result: number) => void
) => void

const { sessionCreatedListeners } = vi.hoisted(() => {
  const listeners: ((session: unknown) => void)[] = []
  return { sessionCreatedListeners: listeners }
})

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: (session: unknown) => void) => {
      if (event === 'session-created') {
        sessionCreatedListeners.push(listener)
      }
    }
  }
}))

import { installDistrustedCertificateVerifyProc } from './distrusted-certificate-verify-proc'

const distrustedFixture = (
  readFileSync(
    join(__dirname, '../../shared/__fixtures__/distrusted-emsign-certificates.pem'),
    'utf8'
  ).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
).map((pem) => ({ pem, certificate: new X509Certificate(pem) }))

function distrusted(match: (certificate: X509Certificate) => boolean): string {
  const found = distrustedFixture.find((entry) => match(entry.certificate))
  if (!found) {
    throw new Error('fixture certificate missing')
  }
  return found.pem
}

function trustedRoot(commonName: string): string {
  const pem = tls.rootCertificates.find(
    (candidate) => new X509Certificate(candidate).subject.match(/^CN=(.+)$/m)?.[1] === commonName
  )
  if (!pem) {
    throw new Error(`missing root ${commonName}`)
  }
  return pem
}

function chain(...pems: string[]): ChainLink | undefined {
  return pems.reduceRight<ChainLink | undefined>(
    (issuerCert, data) => (issuerCert ? { data, issuerCert } : { data }),
    undefined
  )
}

function sessionVerifyProc(): VerifyProc {
  let installed: VerifyProc | null = null
  const createdSession = {
    setCertificateVerifyProc: (proc: VerifyProc) => {
      installed = proc
    }
  }
  for (const listener of sessionCreatedListeners) {
    listener(createdSession)
  }
  if (!installed) {
    throw new Error('no verify proc installed for the created session')
  }
  return installed
}

function verify(
  validatedCertificate: ChainLink | undefined,
  errorCode = 0,
  certificate?: ChainLink
): number | undefined {
  let result: number | undefined
  sessionVerifyProc()({ validatedCertificate, certificate, errorCode }, (value) => {
    result = value
  })
  return result
}

describe('installDistrustedCertificateVerifyProc', () => {
  const leafStandIn = trustedRoot('ISRG Root X2')
  const crossSignedIntermediate = distrusted((certificate) =>
    certificate.issuer.includes('CN=AAA Certificate Services')
  )
  const nssRemovedRoot = distrusted((certificate) =>
    certificate.subject.includes('CN=emSign ECC Root CA - G3')
  )

  beforeEach(() => {
    sessionCreatedListeners.length = 0
    installDistrustedCertificateVerifyProc()
  })

  it('revokes a chain Chromium accepted through a compromised cross-signed intermediate', () => {
    expect(verify(chain(leafStandIn, crossSignedIntermediate))).toBe(-206)
  })

  it('revokes a chain Chromium accepted under a root NSS removed', () => {
    expect(verify(chain(leafStandIn, nssRemovedRoot))).toBe(-206)
  })

  it('revokes compromised chains even when Chromium reports an overridable authority error', () => {
    expect(verify(chain(leafStandIn, crossSignedIntermediate), -202)).toBe(-206)
  })

  it('checks the presented chain when verification omits or truncates the validated chain', () => {
    const presented = chain(leafStandIn, crossSignedIntermediate)
    expect(verify(undefined, -202, presented)).toBe(-206)
    expect(verify(chain(leafStandIn), -202, presented)).toBe(-206)
  })

  it.each([16, 24])('revokes a distrusted key at depth %i in either chain', (depth) => {
    const longChain = chain(...Array.from({ length: depth }, () => leafStandIn), nssRemovedRoot)
    expect(verify(longChain)).toBe(-206)
    expect(verify(chain(leafStandIn), -202, longChain)).toBe(-206)
  })

  it.each([1, 3])('terminates an unaffected cycle of %i certificates', (length) => {
    const links: ChainLink[] = Array.from({ length }, () => ({ data: leafStandIn }))
    for (const [index, link] of links.entries()) {
      link.issuerCert = links[(index + 1) % links.length]
    }
    expect(verify(links[0])).toBe(-3)
    expect(verify(undefined, -202, links[0])).toBe(-3)
  })

  it('revokes a distrusted key inside a cycle', () => {
    const leaf: ChainLink = { data: leafStandIn }
    const issuer: ChainLink = { data: crossSignedIntermediate, issuerCert: leaf }
    leaf.issuerCert = issuer
    expect(verify(leaf)).toBe(-206)
    expect(verify(undefined, -202, leaf)).toBe(-206)
  })

  it("keeps Chromium's verdict for unaffected chains, including local authority errors", () => {
    const unaffected = chain(leafStandIn, trustedRoot('ISRG Root X1'))
    expect(verify(unaffected)).toBe(-3)
    expect(verify(unaffected, -202)).toBe(-3)
    expect(verify(undefined, -202, unaffected)).toBe(-3)
  })
})
