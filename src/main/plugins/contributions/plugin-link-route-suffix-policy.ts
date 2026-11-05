import { parse } from 'tldts'
import {
  normalizeRoutePattern,
  type NormalizedRoutePattern
} from '../../../shared/plugins/contributions/plugin-link-route-matching'

// Second half of the link-route safety floor. Lives in main because it needs the public suffix list;
// the shape rules stay in the shared zod schema so `PluginManifest` keeps its guarantee.

// RFC 6761 / RFC 2606 names are never publicly registered, so `tldts` reports no registrable domain
// for them. Exempt them rather than rejecting the dev-hostname case the feature exists for.
const RESERVED_TLDS = new Set(['test', 'localhost', 'local', 'internal', 'example', 'invalid'])

// Stands in for the one label `*.` replaces; any LDH label resolves the same under the PSL.
const PROBE_LABEL = 'orca-link-route-probe'

function finalLabel(host: string): string {
  return host.split('.').at(-1) ?? ''
}

/**
 * Reject a label wildcard unless every host it matches shares one registrable domain inside its
 * tail. `*.X` matches `L.X`, so this asks the PSL about `L.X` rather than `X`: that catches a tail
 * that is a suffix (`*.com`, `*.co.uk`, `*.github.io`) and a tail whose children are suffixes under a
 * PSL wildcard rule (`*.nom.br`, `*.oaiusercontent.com`), where each `L.X` is a different tenant.
 *
 * `allowPrivateDomains` matters: it is what makes `github.io` and `s3.amazonaws.com` suffixes rather
 * than ordinary domains, so unrelated tenants stay separated.
 */
export function routePatternViolatesSuffixPolicy(pattern: NormalizedRoutePattern): string | null {
  if (pattern.kind === 'exact') {
    return null
  }
  // A mid-label wildcard is already confined to reserved TLDs by the shared shape rules.
  if (pattern.kind === 'midlabel') {
    return null
  }
  if (RESERVED_TLDS.has(finalLabel(pattern.tail))) {
    return null
  }
  const { domain } = parse(`${PROBE_LABEL}.${pattern.tail}`, { allowPrivateDomains: true })
  if (domain === null || (domain !== pattern.tail && !pattern.tail.endsWith(`.${domain}`))) {
    return `"*.${pattern.tail}" would cover hosts under a public suffix that belong to different owners; narrow it to a domain you control`
  }
  return null
}

/** Validate every declared hostname of a manifest. Returns the first violation, or null. */
export function validateManifestLinkRoutes(
  linkRoutes: readonly { hostname: string }[]
): string | null {
  for (const route of linkRoutes) {
    const pattern = normalizeRoutePattern(route.hostname)
    if (!pattern) {
      return `invalid link route hostname "${route.hostname}"`
    }
    const violation = routePatternViolatesSuffixPolicy(pattern)
    if (violation) {
      return violation
    }
  }
  return null
}
