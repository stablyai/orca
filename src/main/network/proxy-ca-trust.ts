import { X509Certificate } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { normalizeProxyCaPath, type NetworkProxySettings } from '../../shared/network-proxy'

// Why: the only verification failure a proxy CA can explain. COMMON_NAME_INVALID,
// DATE_INVALID and REVOKED stay fatal — an unknown issuer is the MITM case, a
// wrong name or an expired leaf never is.
const OVERRIDABLE_VERIFICATION_RESULT = 'net::ERR_CERT_AUTHORITY_INVALID'

/** Electron's setCertificateVerifyProc callback codes. */
const VERIFY_TRUST = 0
const VERIFY_USE_CHROMIUM_RESULT = -3

// Why: bound the presented chain so a hostile peer cannot make us walk forever.
const MAX_CHAIN_DEPTH = 10

export type ProxyCaBundle = {
  path: string
  anchors: X509Certificate[]
}

type CacheEntry = {
  key: string
  bundle: ProxyCaBundle | null
  error: string | null
}

let cache: CacheEntry | null = null

export function resetProxyCaCacheForTests(): void {
  cache = null
}

/** Read the CA bundle, memoized on (path, size, mtime) so a rotated CA is picked up. */
export function loadProxyCaBundle(caPath: string): {
  bundle: ProxyCaBundle | null
  error: string | null
} {
  let key: string
  try {
    const stats = statSync(caPath)
    key = `${caPath}\0${stats.size}\0${stats.mtimeMs}`
  } catch (cause) {
    const error = `Proxy CA file could not be read: ${(cause as Error).message}`
    cache = { key: `${caPath}\0missing`, bundle: null, error }
    return { bundle: null, error }
  }

  if (cache?.key === key) {
    return { bundle: cache.bundle, error: cache.error }
  }

  try {
    const pem = readFileSync(caPath, 'utf8')
    // Why split rather than hand the file to X509Certificate: the constructor
    // parses only the first certificate, and a proxy CA file legitimately holds
    // an intermediate and a root.
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (!blocks?.length) {
      const error = 'Proxy CA file contains no PEM certificate.'
      cache = { key, bundle: null, error }
      return { bundle: null, error }
    }
    const anchors = blocks.map((block) => new X509Certificate(block))
    cache = { key, bundle: { path: caPath, anchors }, error: null }
    return { bundle: cache.bundle, error: null }
  } catch (cause) {
    const error = `Proxy CA file could not be parsed: ${(cause as Error).message}`
    cache = { key, bundle: null, error }
    return { bundle: null, error }
  }
}

/** Flatten Electron's linked certificate into leaf-first PEM blocks. */
export function collectPresentedChain(certificate: Electron.Certificate): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let node: Electron.Certificate | undefined = certificate
  while (node?.data && chain.length < MAX_CHAIN_DEPTH) {
    if (seen.has(node.data)) {
      break
    }
    seen.add(node.data)
    chain.push(node.data)
    // Why: Electron makes a self-signed certificate its own issuerCert, which
    // would otherwise loop until MAX_CHAIN_DEPTH.
    node = node.issuerCert === node ? undefined : node.issuerCert
  }
  return chain
}

function isWithinValidityWindow(cert: X509Certificate, now: Date): boolean {
  const from = Date.parse(cert.validFrom)
  const to = Date.parse(cert.validTo)
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return false
  }
  return now.getTime() >= from && now.getTime() <= to
}

/** True when some certificate in the chain is one of the anchors, or was signed by one. */
export function chainIsSignedByProxyCa(
  chainPem: string[],
  anchors: X509Certificate[],
  now: Date = new Date()
): boolean {
  if (!chainPem.length || !anchors.length) {
    return false
  }
  let certs: X509Certificate[]
  try {
    certs = chainPem.map((pem) => new X509Certificate(pem))
  } catch {
    return false
  }

  for (const cert of certs) {
    for (const anchor of anchors) {
      if (cert.raw.equals(anchor.raw)) {
        return isWithinValidityWindow(anchor, now)
      }
      try {
        // Why both: checkIssued only compares issuer and subject names, which any
        // peer can claim. The verify call is what proves the signature.
        if (cert.checkIssued(anchor) && cert.verify(anchor.publicKey)) {
          return isWithinValidityWindow(anchor, now)
        }
      } catch {
        // A malformed or unsupported key simply does not establish trust.
      }
    }
  }
  return false
}

export type ProxyCaVerifyDecision = {
  trusted: boolean
  reason:
    | 'chromium-accepted'
    | 'not-authority-error'
    | 'no-ca-configured'
    | 'hostname-mismatch'
    | 'leaf-expired'
    | 'chain-not-signed-by-ca'
    | 'trusted-by-proxy-ca'
}

/** The trust decision, extracted so the policy is testable without an Electron session. */
export function decideProxyCaVerification(args: {
  verificationResult: string
  hostname: string
  chainPem: string[]
  anchors: X509Certificate[]
  now?: Date
}): ProxyCaVerifyDecision {
  const now = args.now ?? new Date()
  if (args.verificationResult === 'net::OK') {
    return { trusted: false, reason: 'chromium-accepted' }
  }
  if (args.verificationResult !== OVERRIDABLE_VERIFICATION_RESULT) {
    return { trusted: false, reason: 'not-authority-error' }
  }
  if (!args.anchors.length) {
    return { trusted: false, reason: 'no-ca-configured' }
  }

  let leaf: X509Certificate
  try {
    leaf = new X509Certificate(args.chainPem[0] ?? '')
  } catch {
    return { trusted: false, reason: 'chain-not-signed-by-ca' }
  }
  if (!isWithinValidityWindow(leaf, now)) {
    return { trusted: false, reason: 'leaf-expired' }
  }
  // Why check the host ourselves: Chromium reports one error code, so an authority
  // failure can hide a name mismatch behind it. Trusting the CA must not also
  // accept a certificate minted for a different origin.
  if (args.hostname && !leaf.checkHost(args.hostname)) {
    return { trusted: false, reason: 'hostname-mismatch' }
  }
  if (!chainIsSignedByProxyCa(args.chainPem, args.anchors, now)) {
    return { trusted: false, reason: 'chain-not-signed-by-ca' }
  }
  return { trusted: true, reason: 'trusted-by-proxy-ca' }
}

export type ProxyCaVerifyRequest = {
  hostname: string
  certificate: Electron.Certificate
  verificationResult: string
}

// Why structural, with an optional method: ProxySession is a hand-written shape
// that test fakes also implement, and most have no reason to model verification.
export type ProxyCaTrustSession = {
  setCertificateVerifyProc?: (
    proc: ((request: ProxyCaVerifyRequest, callback: (result: number) => void) => void) | null
  ) => void
}

/**
 * Trust a TLS-intercepting proxy's CA on one session, or clear it when unset.
 *
 * Chromium ignores NODE_EXTRA_CA_CERTS and reads only the OS trust store, so
 * without this the alternative is installing the CA system-wide, widening trust
 * for every process on the machine.
 *
 * Takes effect for certificates this session has not verified yet. Chromium
 * caches a verdict per session and consults the proc only on a miss, and no
 * session API flushes that cache — re-applying setProxy and closing every
 * connection were both measured and neither re-verifies. Editing the CA after a
 * host has already failed therefore needs an Orca restart.
 */
export function applyProxyCaTrustToSession(
  proxySession: ProxyCaTrustSession,
  settings: NetworkProxySettings | null | undefined,
  onDiagnostic: (message: string) => void = (message) => {
    console.warn(`[proxy] ${message}`)
  }
): boolean {
  if (!proxySession.setCertificateVerifyProc) {
    return false
  }
  const caPath = normalizeProxyCaPath(settings?.httpProxyCaPath)
  if (!caPath.ok || !caPath.value) {
    proxySession.setCertificateVerifyProc(null)
    return false
  }

  const { bundle, error } = loadProxyCaBundle(caPath.value)
  if (!bundle) {
    // Why not fail closed: the CA only ever adds trust, so a bad path must leave
    // Chromium's own verification as it was rather than break every request.
    onDiagnostic(error ?? 'Proxy CA could not be loaded.')
    proxySession.setCertificateVerifyProc(null)
    return false
  }

  proxySession.setCertificateVerifyProc((request, callback) => {
    const decision = decideProxyCaVerification({
      verificationResult: request.verificationResult,
      hostname: request.hostname,
      chainPem: collectPresentedChain(request.certificate),
      anchors: bundle.anchors
    })
    callback(decision.trusted ? VERIFY_TRUST : VERIFY_USE_CHROMIUM_RESULT)
  })
  return true
}
