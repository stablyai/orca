import { normalizeCookieDomain } from './browser-cookie-import-policy'
import {
  readJsonCookiePartition,
  type SourcePartitionRead
} from './browser-cookie-source-partition'
import type { ImportedCookieFields } from './browser-cookie-import-write'

export type RawCookieEntry = {
  domain?: unknown
  name?: unknown
  value?: unknown
  path?: unknown
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expirationDate?: unknown
  partitionKey?: unknown
  partitionKeyOpaque?: unknown
}

// Why (STA-4300): `partition` is required, not optional, so every source that builds a cookie has to
// state what it read. An optional field would let a new source silently default to unpartitioned.
export type ValidatedCookie = ImportedCookieFields & {
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  partition: SourcePartitionRead
}

// Why: Chromium's CookieSameSiteForStorage enum (0=Unspecified,1=None,2=Lax,3=Strict) differs from Firefox's numbering.
export function chromiumSameSite(raw: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (raw) {
    case 1:
      return 'no_restriction'
    case 2:
      return 'lax'
    case 3:
      return 'strict'
    default:
      return 'unspecified'
  }
}

export function firefoxSameSite(raw: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (raw) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

export function normalizeSameSite(
  raw: unknown
): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (typeof raw === 'number') {
    return chromiumSameSite(raw)
  }
  if (typeof raw !== 'string') {
    return 'unspecified'
  }
  const lower = raw.toLowerCase()
  if (lower === 'lax') {
    return 'lax'
  }
  if (lower === 'strict') {
    return 'strict'
  }
  if (lower === 'none' || lower === 'no_restriction') {
    return 'no_restriction'
  }
  return 'unspecified'
}

// Why: a cookie identity needs a url to scope it; derive it from domain + secure flag.
export function deriveUrl(domain: string, secure: boolean): string | null {
  const normalizedDomain = normalizeCookieDomain(domain)
  if (!normalizedDomain) {
    return null
  }
  const protocol = secure ? 'https' : 'http'
  try {
    const url = new URL(`${protocol}://${normalizedDomain}/`)
    return url.toString()
  } catch {
    return null
  }
}

export function validateCookieEntry(raw: RawCookieEntry): ValidatedCookie | null {
  if (typeof raw.domain !== 'string' || raw.domain.trim().length === 0) {
    return null
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return null
  }
  if (typeof raw.value !== 'string') {
    return null
  }

  const domain = raw.domain.trim()
  const secure = raw.secure === true || raw.secure === 1
  const url = deriveUrl(domain, secure)
  if (!url) {
    return null
  }

  const expirationDate =
    typeof raw.expirationDate === 'number' && raw.expirationDate > 0
      ? raw.expirationDate
      : undefined

  return {
    url,
    name: raw.name.trim(),
    value: raw.value,
    domain,
    path: typeof raw.path === 'string' ? raw.path : '/',
    secure,
    httpOnly: raw.httpOnly === true || raw.httpOnly === 1,
    sameSite: normalizeSameSite(raw.sameSite),
    expirationDate,
    partition: readJsonCookiePartition(raw.partitionKey, raw.partitionKeyOpaque)
  }
}
