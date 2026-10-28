import { parse as parseDomain } from 'tldts'

// Domain-list semantics from url_pattern_index.cc (CompareDomains, GetLongestMatchingSubdomain,
// DoesHostMatchDomainLists) and net's SameDomainOrHost for domainType.

/** CompareDomains order: longer first, then lexicographic. Lists are stored in this order. */
export function compareDomains(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length > right.length ? -1 : 1
  }
  return left < right ? -1 : left > right ? 1 : 0
}

/** url::DomainIs on canonical (lower-case) strings; a trailing dot on the host is ignored. */
function domainIs(host: string, domain: string): boolean {
  if (host.length === 0 || domain.length === 0) {
    return false
  }
  let hostLength = host.length
  if (host.endsWith('.') && !domain.endsWith('.')) {
    hostLength--
  }
  if (hostLength < domain.length) {
    return false
  }
  const start = hostLength - domain.length
  if (!host.startsWith(domain, start)) {
    return false
  }
  return domain[0] === '.' || hostLength === domain.length || host[start - 1] === '.'
}

/** A sorted domain list; Chromium scans short lists and binary-searches long ones. */
export class DnrDomainList {
  readonly domains: readonly string[]
  private readonly lookup: ReadonlySet<string> | null

  constructor(domains: readonly string[]) {
    this.domains = [...domains].sort(compareDomains)
    this.lookup = this.domains.length > 5 ? new Set(this.domains) : null
  }

  /** Length of the longest listed (sub-)domain of `host`, or 0. */
  longestMatch(host: string, suffixes: readonly string[]): number {
    if (host.length === 0) {
      return 0
    }
    if (this.lookup === null) {
      for (const domain of this.domains) {
        if (domainIs(host, domain)) {
          return domain.length
        }
      }
      return 0
    }
    // The binary-search path compares whole label suffixes only, so `.com` entries never match
    // here though they do in short lists. That mirrors Chromium exactly.
    for (const suffix of suffixes) {
      if (this.lookup.has(suffix)) {
        return suffix.length
      }
    }
    return 0
  }
}

/** Label suffixes of a host in decreasing length, ignoring one trailing dot. */
export function hostLabelSuffixes(host: string): string[] {
  const trimmed = host.endsWith('.') ? host.slice(0, -1) : host
  if (trimmed.length === 0) {
    return []
  }
  const suffixes = [trimmed]
  for (let dot = trimmed.indexOf('.'); dot !== -1; dot = trimmed.indexOf('.', dot + 1)) {
    suffixes.push(trimmed.slice(dot + 1))
  }
  return suffixes
}

/** DoesHostMatchDomainLists: excluded wins only when at least as specific as the included hit. */
export function hostMatchesDomainLists(
  host: string,
  suffixes: readonly string[],
  included: DnrDomainList | null,
  excluded: DnrDomainList | null
): boolean {
  const longestIncluded = included === null ? 1 : included.longestMatch(host, suffixes)
  if (longestIncluded > 0 && excluded !== null) {
    return excluded.longestMatch(host, suffixes) < longestIncluded
  }
  return longestIncluded > 0
}

const registrableDomainCache = new Map<string, string | null>()
const REGISTRABLE_DOMAIN_CACHE_LIMIT = 4096

/**
 * GetDomainAndRegistry with INCLUDE_PRIVATE_REGISTRIES and EXCLUDE_UNKNOWN_REGISTRIES:
 * hosts on unlisted TLDs, IPs and bare suffixes have no registrable domain.
 */
function registrableDomain(host: string): string | null {
  const cached = registrableDomainCache.get(host)
  if (cached !== undefined) {
    return cached
  }
  if (host.startsWith('[')) {
    return null
  }
  const parsed = parseDomain(host, { allowPrivateDomains: true, extractHostname: false })
  const listed = parsed.isIcann === true || parsed.isPrivate === true
  const domain = parsed.isIp || !listed ? null : parsed.domain
  if (registrableDomainCache.size >= REGISTRABLE_DOMAIN_CACHE_LIMIT) {
    registrableDomainCache.clear()
  }
  registrableDomainCache.set(host, domain)
  return domain
}

/** net::registry_controlled_domains::SameDomainOrHost. */
export function sameDomainOrHost(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false
  }
  if (left === right) {
    return true
  }
  const domain = registrableDomain(left)
  return domain !== null && domain === registrableDomain(right)
}
