import { net } from 'electron'
import type {
  CustomProviderAccount,
  CustomProviderUsageFailureKind,
  CustomProviderUsageResult
} from '../../shared/custom-provider-types'

const API_TIMEOUT_MS = 10_000

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Substitutes {yyyy}/{mm}/{dd} with today's UTC date — documented as UTC in the Settings UI
 *  so a daily-reset API's boundary matches what the user sees, regardless of local timezone. */
export function substituteDatePlaceholders(url: string, now: Date): string {
  return url
    .replace(/\{yyyy\}/g, String(now.getUTCFullYear()))
    .replace(/\{mm\}/g, pad2(now.getUTCMonth() + 1))
    .replace(/\{dd\}/g, pad2(now.getUTCDate()))
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

type PathSegment = string | number

const PATH_SEGMENT_PATTERN = /^(?:[^[\].]+|\[\d+\])+$/
const PATH_TOKEN_PATTERN = /[^[\].]+|\[(\d+)\]/g

// Why: a deliberately small grammar (dot keys + numeric array indices) instead of full
// JSONPath/JMESPath — per usability review, more power here would hurt supportability for a
// semi-technical audience without adding real capability for this feature's stated use case.
// Rejects malformed syntax explicitly (e.g. "a[bad]", trailing dots) instead of silently
// dropping the unparsed remainder, so a typo surfaces as a config error, not a wrong value.
export function parsePathSegments(path: string): PathSegment[] | null {
  if (path.trim().length === 0) {
    return null
  }
  const parts = path.split('.')
  if (parts.some((part) => part.length === 0 || !PATH_SEGMENT_PATTERN.test(part))) {
    return null
  }
  return parts.flatMap((part) =>
    [...part.matchAll(PATH_TOKEN_PATTERN)].map((match) =>
      match[1] !== undefined ? Number(match[1]) : match[0]
    )
  )
}

type PathResolution = { found: true; value: unknown } | { found: false; invalidSyntax?: true }

export function resolveJsonPath(data: unknown, path: string): PathResolution {
  const segments = parsePathSegments(path)
  if (segments === null) {
    return { found: false, invalidSyntax: true }
  }
  let current: unknown = data
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { found: false }
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false }
      }
      current = current[segment]
    } else {
      // Why: `in` also matches inherited/prototype properties (e.g. "constructor"),
      // which would resolve truthily against a response that has no such field.
      if (!Object.hasOwn(current, segment)) {
        return { found: false }
      }
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current === undefined ? { found: false } : { found: true, value: current }
}

type NumericPathResult =
  | { kind: 'ok'; value: number }
  | { kind: 'not-found' }
  | { kind: 'non-numeric' }
  | { kind: 'invalid-syntax' }

function resolveNumericPath(data: unknown, path: string): NumericPathResult {
  const resolved = resolveJsonPath(data, path)
  if (!resolved.found) {
    return resolved.invalidSyntax ? { kind: 'invalid-syntax' } : { kind: 'not-found' }
  }
  return typeof resolved.value === 'number' && Number.isFinite(resolved.value)
    ? { kind: 'ok', value: resolved.value }
    : { kind: 'non-numeric' }
}

function result(
  accountId: string,
  status: CustomProviderUsageResult['status'],
  error: string | null,
  failureKind?: CustomProviderUsageFailureKind,
  usedPercent: number | null = null,
  resetsAt: number | null = null
): CustomProviderUsageResult {
  return {
    accountId,
    usedPercent,
    resetsAt,
    updatedAt: Date.now(),
    error,
    status,
    ...(failureKind ? { failureKind } : {})
  }
}

type MappingFailure = { failureKind: CustomProviderUsageFailureKind; error: string }

function numericPathFailure(
  result: Extract<NumericPathResult, { kind: 'not-found' | 'non-numeric' | 'invalid-syntax' }>,
  label: string,
  path: string
): MappingFailure {
  if (result.kind === 'invalid-syntax') {
    return { failureKind: 'invalid-path-syntax', error: `${label} path "${path}" is malformed` }
  }
  if (result.kind === 'not-found') {
    return { failureKind: 'path-not-found', error: `${label} path "${path}" did not resolve` }
  }
  return { failureKind: 'non-numeric', error: `${label} path "${path}" is not a number` }
}

function computeUsedPercent(
  account: CustomProviderAccount,
  data: unknown
): { percent: number } | MappingFailure {
  if (account.mappingMode === 'percent') {
    const path = account.percentPath ?? ''
    const resolved = resolveNumericPath(data, path)
    if (resolved.kind !== 'ok') {
      return numericPathFailure(resolved, 'Percent', path)
    }
    if (resolved.value < 0 || resolved.value > 100) {
      return {
        failureKind: 'out-of-range',
        error: `Percent path "${path}" resolved to ${resolved.value}, outside 0-100`
      }
    }
    return { percent: resolved.value }
  }

  let used = 0
  for (const path of account.usedPaths ?? []) {
    const resolved = resolveNumericPath(data, path)
    if (resolved.kind !== 'ok') {
      return numericPathFailure(resolved, 'Used', path)
    }
    used += resolved.value
  }
  if (!Number.isFinite(used) || used < 0) {
    return {
      failureKind: 'out-of-range',
      error: `Summed used value (${used}) must be a finite, non-negative number`
    }
  }
  const limitPath = account.limitPath ?? ''
  const limitResolved = resolveNumericPath(data, limitPath)
  if (limitResolved.kind !== 'ok') {
    return numericPathFailure(limitResolved, 'Limit', limitPath)
  }
  if (limitResolved.value <= 0) {
    return { failureKind: 'invalid-limit', error: `Limit path "${limitPath}" resolved to <= 0` }
  }
  return { percent: Math.min(100, (used / limitResolved.value) * 100) }
}

/** Read-only usage check for a user-defined custom provider account. Bring-your-own-endpoint:
 *  Orca calls `account.usageUrl` (with {yyyy}/{mm}/{dd} substituted) and maps the JSON response
 *  through the account's configured path grammar — see custom-provider-types.ts. */
export async function fetchCustomProviderUsage(
  account: CustomProviderAccount,
  token: string | null,
  now: Date = new Date()
): Promise<CustomProviderUsageResult> {
  if (!token) {
    return result(account.id, 'unavailable', 'No token configured', 'missing-token')
  }

  const url = substituteDatePlaceholders(account.usageUrl, now)
  const resetsAt = account.usageUrl.includes('{') ? nextUtcMidnight(now).getTime() : null

  let res: Response
  try {
    res = await net.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    return result(
      account.id,
      'error',
      err instanceof Error ? err.message : 'Custom provider usage request failed',
      isTimeout ? 'timeout' : 'network'
    )
  }

  if (res.status === 401 || res.status === 403) {
    return result(account.id, 'error', `Unauthorized (HTTP ${res.status})`, 'unauthorized')
  }
  if (!res.ok) {
    return result(account.id, 'error', `Request failed (HTTP ${res.status})`, 'unknown')
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    return result(account.id, 'error', 'Response was not valid JSON', 'non-json')
  }

  const computed = computeUsedPercent(account, data)
  if ('failureKind' in computed) {
    return result(account.id, 'error', computed.error, computed.failureKind)
  }
  return result(account.id, 'ok', null, undefined, computed.percent, resetsAt)
}
