import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LEAF, PROXY_CA, UNRELATED_CA } from './__fixtures__/proxy-ca-fixtures'
import {
  applyProxyCaTrustToSession,
  chainIsSignedByProxyCa,
  collectPresentedChain,
  decideProxyCaVerification,
  loadProxyCaBundle,
  resetProxyCaCacheForTests
} from './proxy-ca-trust'

const AUTHORITY_ERROR = 'net::ERR_CERT_AUTHORITY_INVALID'

function anchors(...pems: string[]): X509Certificate[] {
  return pems.map((pem) => new X509Certificate(pem))
}

/** Electron hands the chain over as a linked list; build the same shape. */
function electronCertificate(chain: string[]): Electron.Certificate {
  let node: Electron.Certificate | undefined
  for (const data of chain.toReversed()) {
    const next = { data } as Electron.Certificate
    if (node) {
      ;(next as { issuerCert?: Electron.Certificate }).issuerCert = node
    }
    node = next
  }
  return node as Electron.Certificate
}

describe('proxy CA trust', () => {
  beforeEach(() => {
    resetProxyCaCacheForTests()
  })

  it('trusts a leaf signed by the configured proxy CA', () => {
    const decision = decideProxyCaVerification({
      verificationResult: AUTHORITY_ERROR,
      hostname: 'api.example.com',
      chainPem: [LEAF],
      anchors: anchors(PROXY_CA)
    })
    expect(decision).toEqual({ trusted: true, reason: 'trusted-by-proxy-ca' })
  })

  it('does not second-guess Chromium when it already accepted the chain', () => {
    expect(
      decideProxyCaVerification({
        verificationResult: 'net::OK',
        hostname: 'api.example.com',
        chainPem: [LEAF],
        anchors: anchors(PROXY_CA)
      })
    ).toEqual({ trusted: false, reason: 'chromium-accepted' })
  })

  it('only overrides an unknown-authority failure', () => {
    // A proxy CA explains an unknown issuer, never a revoked chain.
    expect(
      decideProxyCaVerification({
        verificationResult: 'net::ERR_CERT_REVOKED',
        hostname: 'api.example.com',
        chainPem: [LEAF],
        anchors: anchors(PROXY_CA)
      })
    ).toEqual({ trusted: false, reason: 'not-authority-error' })
  })

  it('rejects a certificate minted for a different host', () => {
    // Keeps this from being a blanket bypass: one Chromium error code can mask a
    // name mismatch behind the authority failure.
    expect(
      decideProxyCaVerification({
        verificationResult: AUTHORITY_ERROR,
        hostname: 'evil.example.net',
        chainPem: [LEAF],
        anchors: anchors(PROXY_CA)
      })
    ).toEqual({ trusted: false, reason: 'hostname-mismatch' })
  })

  it('rejects a chain signed by some other CA', () => {
    expect(
      decideProxyCaVerification({
        verificationResult: AUTHORITY_ERROR,
        hostname: 'api.example.com',
        chainPem: [LEAF],
        anchors: anchors(UNRELATED_CA)
      })
    ).toEqual({ trusted: false, reason: 'chain-not-signed-by-ca' })
  })

  it('rejects a leaf outside its validity window', () => {
    expect(
      decideProxyCaVerification({
        verificationResult: AUTHORITY_ERROR,
        hostname: 'api.example.com',
        chainPem: [LEAF],
        anchors: anchors(PROXY_CA),
        now: new Date('2050-01-01T00:00:00Z')
      })
    ).toEqual({ trusted: false, reason: 'leaf-expired' })
  })

  it('reports no CA configured rather than guessing', () => {
    expect(
      decideProxyCaVerification({
        verificationResult: AUTHORITY_ERROR,
        hostname: 'api.example.com',
        chainPem: [LEAF],
        anchors: []
      })
    ).toEqual({ trusted: false, reason: 'no-ca-configured' })
  })

  it('accepts the CA appearing in the presented chain itself', () => {
    expect(chainIsSignedByProxyCa([PROXY_CA], anchors(PROXY_CA))).toBe(true)
  })

  it('requires a real signature, not just a matching issuer name', () => {
    expect(chainIsSignedByProxyCa([LEAF], anchors(UNRELATED_CA))).toBe(false)
    expect(chainIsSignedByProxyCa([], anchors(PROXY_CA))).toBe(false)
    expect(chainIsSignedByProxyCa([LEAF], [])).toBe(false)
  })

  it('walks the Electron chain without looping on a self-signed issuer', () => {
    const selfSigned = { data: PROXY_CA } as Electron.Certificate
    ;(selfSigned as { issuerCert?: Electron.Certificate }).issuerCert = selfSigned
    expect(collectPresentedChain(selfSigned)).toEqual([PROXY_CA])
    expect(collectPresentedChain(electronCertificate([LEAF, PROXY_CA]))).toEqual([LEAF, PROXY_CA])
  })

  it('loads every certificate in a bundle, not just the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-proxy-ca-'))
    const path = join(dir, 'bundle.pem')
    writeFileSync(path, `${PROXY_CA}\n${UNRELATED_CA}\n`)
    const { bundle, error } = loadProxyCaBundle(path)
    expect(error).toBeNull()
    expect(bundle?.anchors).toHaveLength(2)
  })

  it('reports a missing or unparsable CA file instead of throwing', () => {
    const missing = loadProxyCaBundle(join(tmpdir(), 'orca-proxy-ca-does-not-exist.pem'))
    expect(missing.bundle).toBeNull()
    expect(missing.error).toMatch(/could not be read/)

    const dir = mkdtempSync(join(tmpdir(), 'orca-proxy-ca-'))
    const path = join(dir, 'garbage.pem')
    writeFileSync(path, 'not a certificate')
    const parsed = loadProxyCaBundle(path)
    expect(parsed.bundle).toBeNull()
    expect(parsed.error).toMatch(/no PEM certificate/)
  })

  it('installs the override only when a readable CA is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-proxy-ca-'))
    const path = join(dir, 'ca.pem')
    writeFileSync(path, PROXY_CA)
    const setCertificateVerifyProc = vi.fn()
    const session = { setCertificateVerifyProc }

    expect(applyProxyCaTrustToSession(session, { httpProxyCaPath: path })).toBe(true)
    expect(setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function))

    setCertificateVerifyProc.mockClear()
    expect(applyProxyCaTrustToSession(session, { httpProxyCaPath: '' })).toBe(false)
    expect(setCertificateVerifyProc).toHaveBeenCalledWith(null)
  })

  it('leaves Chromium verification untouched when the CA cannot be loaded', () => {
    // The CA only ever adds trust, so a bad path must not break every request.
    const setCertificateVerifyProc = vi.fn()
    const onDiagnostic = vi.fn()
    const installed = applyProxyCaTrustToSession(
      { setCertificateVerifyProc },
      { httpProxyCaPath: join(tmpdir(), 'orca-proxy-ca-absent.pem') },
      onDiagnostic
    )
    expect(installed).toBe(false)
    expect(setCertificateVerifyProc).toHaveBeenCalledWith(null)
    expect(onDiagnostic).toHaveBeenCalledOnce()
  })

  it('defers to Chromium through the installed proc unless the CA vouches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-proxy-ca-'))
    const path = join(dir, 'ca.pem')
    writeFileSync(path, PROXY_CA)
    // Why an array rather than a `let`: TypeScript cannot see the assignment
    // through the callback and narrows the variable to `never` at the call site.
    const installed: ((
      request: { hostname: string; certificate: Electron.Certificate; verificationResult: string },
      callback: (result: number) => void
    ) => void)[] = []
    applyProxyCaTrustToSession(
      {
        setCertificateVerifyProc: (proc) => {
          if (proc) {
            installed.push(proc)
          }
        }
      },
      { httpProxyCaPath: path }
    )
    const proc = installed[0]
    expect(proc).toBeTypeOf('function')

    const results: number[] = []
    proc?.(
      {
        hostname: 'api.example.com',
        certificate: electronCertificate([LEAF]),
        verificationResult: AUTHORITY_ERROR
      },
      (result) => results.push(result)
    )
    proc?.(
      {
        hostname: 'evil.example.net',
        certificate: electronCertificate([LEAF]),
        verificationResult: AUTHORITY_ERROR
      },
      (result) => results.push(result)
    )
    // 0 trusts; -3 hands the decision back to Chromium.
    expect(results).toEqual([0, -3])
  })
})
