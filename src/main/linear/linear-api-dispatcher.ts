import { createRequire } from 'node:module'
import { getCACertificates } from 'node:tls'
import type { Dispatcher } from 'undici'

// Why: TLS-inspecting networks (Cloudflare WARP, Zscaler, corporate proxies)
// re-sign api.linear.app with a CA that only exists in the OS trust store.
// Node's fetch trusts its own bundled roots, so every Linear request dies as
// SELF_SIGNED_CERT_IN_CHAIN — and the SDK erases the cause, leaving users with
// a bare "Fetch failed" (orca#12189). Dispatch Linear traffic through an agent
// that trusts Node's defaults *plus* the OS store. Scoped to Linear so no other
// transport silently inherits the wider trust set.

// Why: `undici` costs ~47ms to parse and this module is reachable from the
// main-process startup path. Load it on first Linear request, like ./linear-sdk
// does for the SDK itself.
const requireFromMain = createRequire(__filename)

type UndiciModule = {
  Agent: new (options: { connect: { ca: string[] } }) => Dispatcher
}

let cachedDispatcher: Dispatcher | null = null
let dispatcherResolved = false

export function getLinearApiDispatcher(): Dispatcher | undefined {
  if (!dispatcherResolved) {
    dispatcherResolved = true
    cachedDispatcher = createSystemTrustDispatcher()
  }
  return cachedDispatcher ?? undefined
}

// Why: 'default' is what Node would have used on its own (bundled roots, or the
// NODE_EXTRA_CA_CERTS bundle when the user set one), so merging rather than
// replacing keeps every certificate that already worked.
export function collectTrustedCaCertificates(): string[] {
  return dedupeCertificates([getCACertificates('default'), getCACertificates('system')])
}

export function dedupeCertificates(sources: readonly (readonly string[])[]): string[] {
  return [...new Set(sources.flat())]
}

function createSystemTrustDispatcher(): Dispatcher | null {
  try {
    const { Agent } = requireFromMain('undici') as UndiciModule
    return new Agent({ connect: { ca: collectTrustedCaCertificates() } })
  } catch (error) {
    // Why: a missing OS trust store must degrade to Node's default trust, not
    // break Linear for everyone on a normal network.
    console.warn('[linear] system certificate trust unavailable:', error)
    return null
  }
}
