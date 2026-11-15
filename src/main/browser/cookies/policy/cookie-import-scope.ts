import { parse as parseDomain } from 'tldts'
import {
  PUBLIC_SUFFIX_OPTIONS,
  normalizeCookieDomain,
  normalizeCookieImportDomain
} from './cookie-domain'

function domainSuffixes(domain: string): string[] {
  const labels = domain.split('.')
  return labels.map((_, index) => labels.slice(index).join('.'))
}

function importDomainAncestors(domain: string): string[] {
  const parsed = parseDomain(domain, PUBLIC_SUFFIX_OPTIONS)
  const boundary = parsed.hostname === null ? domain : (parsed.domain ?? domain)
  const ancestors: string[] = []
  for (const suffix of domainSuffixes(domain)) {
    ancestors.push(suffix)
    if (suffix === boundary) {
      break
    }
  }
  return ancestors
}

// Share removal scope across live imports, replacements, and staged replay to protect unrelated sessions.
export type ImportedDomainScope = {
  exact: Set<string>
  ancestors: Set<string>
  descendantRoots: Set<string>
}

export function importedDomainScope(domains: readonly string[]): ImportedDomainScope {
  const exact = new Set<string>()
  const ancestors = new Set<string>()
  const descendantRoots = new Set<string>()
  const seen = new Set<string>()
  for (const domain of domains) {
    const candidate = normalizeCookieDomain(domain)
    if (!candidate || seen.has(candidate)) {
      continue
    }
    seen.add(candidate)
    const normalized = normalizeCookieImportDomain(candidate)
    if (!normalized || exact.has(normalized)) {
      continue
    }
    exact.add(normalized)
    if (normalized.includes('.')) {
      descendantRoots.add(normalized)
    }
    for (const suffix of importDomainAncestors(normalized)) {
      ancestors.add(suffix)
    }
  }
  return { exact, ancestors, descendantRoots }
}

// Staged rows derive hostOnly from host_key, without constructing an Electron Cookie.
export function domainIsInImportedScope(
  scope: ImportedDomainScope,
  domain: string,
  hostOnly: boolean
): boolean {
  if (scope.exact.has(domain)) {
    return true
  }
  if (!hostOnly && scope.ancestors.has(domain)) {
    return true
  }
  return domainSuffixes(domain).some((suffix) => scope.descendantRoots.has(suffix))
}
