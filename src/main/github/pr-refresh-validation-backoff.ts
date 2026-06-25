import { createHash } from 'crypto'
import { resolve } from 'path'
import { recordCoalescedCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'

const VALIDATION_BACKOFF_TTL_MS = 5 * 60_000
const MAX_VALIDATION_BACKOFF_ENTRIES = 256
const VALIDATION_BREADCRUMB_MIN_INTERVAL_MS = 30_000

export type PRRefreshValidationDenialReason =
  | 'unknown-repo'
  | 'repo-path-mismatch'
  | 'host-mismatch'

type ValidationBackoffIdentity = {
  repoId?: string | null
  repoPath: string
  reason: PRRefreshValidationDenialReason
}

type ValidationBackoffEntry = {
  expiresAt: number
}

type ValidationBackoffCounters = {
  recorded: number
  skipped: number
  expired: number
}

const validationBackoff = new Map<string, ValidationBackoffEntry>()
const counters: ValidationBackoffCounters = {
  recorded: 0,
  skipped: 0,
  expired: 0
}

function validationIdentityKey(identity: ValidationBackoffIdentity): string {
  return [identity.repoId ?? '', resolve(identity.repoPath), identity.reason].join('\0')
}

function validationIdentityToken(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function evictOldestValidationBackoffEntries(): void {
  while (validationBackoff.size > MAX_VALIDATION_BACKOFF_ENTRIES) {
    const oldest = validationBackoff.keys().next()
    if (oldest.done) {
      break
    }
    validationBackoff.delete(oldest.value)
  }
}

function recordValidationBreadcrumb(
  reason: PRRefreshValidationDenialReason,
  result: 'recorded' | 'backoff',
  token: string
): void {
  recordCoalescedCrashBreadcrumb({
    name: 'pr_refresh_validation_skip',
    coalesceKey: `pr-refresh-validation:${reason}:${token}`,
    minIntervalMs: VALIDATION_BREADCRUMB_MIN_INTERVAL_MS,
    data: {
      reason,
      result,
      token,
      recorded: counters.recorded,
      skipped: counters.skipped,
      expired: counters.expired
    }
  })
}

export function notePRRefreshValidationDenial(
  identity: ValidationBackoffIdentity,
  nowMs = Date.now()
): 'validation-denied' | 'validation-backoff' {
  const key = validationIdentityKey(identity)
  const existing = validationBackoff.get(key)
  const token = validationIdentityToken(key)
  if (existing && existing.expiresAt > nowMs) {
    counters.skipped += 1
    recordValidationBreadcrumb(identity.reason, 'backoff', token)
    return 'validation-backoff'
  }
  if (existing) {
    counters.expired += 1
    validationBackoff.delete(key)
  }
  counters.recorded += 1
  validationBackoff.set(key, { expiresAt: nowMs + VALIDATION_BACKOFF_TTL_MS })
  evictOldestValidationBackoffEntries()
  recordValidationBreadcrumb(identity.reason, 'recorded', token)
  return 'validation-denied'
}

export function clearPRRefreshValidationBackoffForTests(): void {
  validationBackoff.clear()
  counters.recorded = 0
  counters.skipped = 0
  counters.expired = 0
}

export function getPRRefreshValidationBackoffCountForTests(): number {
  return validationBackoff.size
}
