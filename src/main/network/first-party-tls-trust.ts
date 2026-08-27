import * as tls from 'node:tls'
import type { SecureContext } from 'node:tls'
import {
  applyLegacySystemCaPolicy,
  loadCaCertificateFile,
  loadLegacySystemCaPolicy
} from './first-party-ca-certificates'

let cachedCaCertificates: Promise<string[]> | undefined
let cachedSecureContext: Promise<SecureContext> | undefined

async function loadCaCertificates(): Promise<string[]> {
  let defaultCertificates: string[]
  try {
    defaultCertificates = tls.getCACertificates('default')
  } catch {
    defaultCertificates = [...tls.rootCertificates]
  }

  let systemCertificates: string[] = []
  try {
    systemCertificates = tls.getCACertificates('system')
  } catch {
    // Node 18 has no policy-aware system certificate API.
  }
  const legacyPolicy =
    process.platform === 'darwin' ||
    process.platform === 'win32' ||
    typeof tls.getCACertificates !== 'function'
      ? await loadLegacySystemCaPolicy()
      : { certificates: [], disallowedDigests: new Set<string>() }
  const explicitCertificates = await loadCaCertificateFile(process.env.NODE_EXTRA_CA_CERTS)
  return applyLegacySystemCaPolicy(
    [
      ...new Set([
        ...defaultCertificates,
        ...systemCertificates,
        ...legacyPolicy.certificates,
        ...explicitCertificates
      ])
    ],
    legacyPolicy
  )
}

export function getFirstPartyCaCertificates(): Promise<string[]> {
  cachedCaCertificates ??= loadCaCertificates()
  return cachedCaCertificates
}

export function getFirstPartySecureContext(): Promise<SecureContext> {
  cachedSecureContext ??= getFirstPartyCaCertificates().then((ca) =>
    tls.createSecureContext({ ca })
  )
  return cachedSecureContext
}
