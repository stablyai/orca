import { getDomain } from 'tldts'

export type BrowserPasswordMatchable = {
  origin: string
  updatedAt: number
  lastUsedAt: number | null
}

export type BrowserPasswordMatches<T> = { exact: T[]; sameSite: T[] }

function parseWebUrl(url: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
}

/** `scheme://host[:port]` of an http(s) URL, as the WHATWG parser serialises it; null otherwise. */
export function toBrowserPasswordOrigin(url: string): string | null {
  return parseWebUrl(url)?.origin ?? null
}

/** eTLD+1 of the origin's host (private suffixes included); IPs and single labels are their own site. */
export function registrableDomainOf(origin: string): string | null {
  const parsed = parseWebUrl(origin)
  if (!parsed) {
    return null
  }
  return getDomain(parsed.hostname, { allowPrivateDomains: true }) ?? parsed.hostname
}

function compareByRecency(a: BrowserPasswordMatchable, b: BrowserPasswordMatchable): number {
  const lastUsed = (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1)
  return lastUsed !== 0 ? lastUsed : b.updatedAt - a.updatedAt
}

/** Exact-origin matches, plus same-scheme/same-port entries on the same registrable domain. */
export function matchBrowserPasswordEntries<T extends BrowserPasswordMatchable>(
  entries: readonly T[],
  pageOrigin: string
): BrowserPasswordMatches<T> {
  const page = parseWebUrl(pageOrigin)
  const pageSite = registrableDomainOf(pageOrigin)
  const exact: T[] = []
  const sameSite: T[] = []
  if (!page || !pageSite) {
    return { exact, sameSite }
  }
  for (const entry of entries) {
    const candidate = parseWebUrl(entry.origin)
    if (!candidate) {
      continue
    }
    if (candidate.origin === page.origin) {
      exact.push(entry)
    } else if (
      candidate.protocol === page.protocol &&
      candidate.port === page.port &&
      registrableDomainOf(candidate.origin) === pageSite
    ) {
      sameSite.push(entry)
    }
  }
  exact.sort(compareByRecency)
  sameSite.sort(compareByRecency)
  return { exact, sameSite }
}
