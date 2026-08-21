import { createSecureContext, getCACertificates, rootCertificates } from 'node:tls'
import type { SecureContext } from 'node:tls'

let cachedCaCertificates: string[] | undefined
let cachedSecureContext: SecureContext | undefined

function loadCaCertificates(): string[] {
  let defaultCertificates: string[]
  try {
    defaultCertificates = getCACertificates('default')
  } catch {
    defaultCertificates = [...rootCertificates]
  }

  let systemCertificates: string[] = []
  try {
    // Node 24 filters macOS and Windows stores through platform trust policy.
    systemCertificates = getCACertificates('system')
  } catch {
    // Keep bundled trust when the runtime cannot read the OS store.
  }
  return [...new Set([...defaultCertificates, ...systemCertificates])]
}

export function getFirstPartyCaCertificates(): string[] {
  cachedCaCertificates ??= loadCaCertificates()
  return cachedCaCertificates
}

export function getFirstPartySecureContext(): SecureContext {
  cachedSecureContext ??= createSecureContext({ ca: getFirstPartyCaCertificates() })
  return cachedSecureContext
}
