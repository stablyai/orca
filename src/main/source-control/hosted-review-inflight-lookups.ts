import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  MAX_INFLIGHT_LOOKUPS
} from './hosted-review-refresh-pacing'

declare const inflightTokenBrand: unique symbol

/** Identity token for one lookup; only ever compared by reference. */
export type InflightToken = { readonly [inflightTokenBrand]?: never }

type InflightRecord = {
  token: InflightToken
  startedAt: number
  promise: Promise<HostedReviewInfo | null>
  expire: () => void
}

const inflight = new Map<string, InflightRecord>()
// Admission bounds these owners to two per key across at most 1,000 unsettled keys.
const retired = new Map<InflightToken, InflightRecord>()

export function getInflightLookup(key: string): InflightRecord | undefined {
  return inflight.get(key)
}

/** Clears only this owner's records; the return value identifies the current owner. */
export function releaseInflight(key: string, token: InflightToken): boolean {
  retired.delete(token)
  if (inflight.get(key)?.token !== token) {
    return false
  }
  inflight.delete(key)
  return true
}

export function retireInflightWithPrefix(prefix: string): void {
  for (const [key, record] of inflight) {
    if (key.startsWith(prefix)) {
      retired.set(record.token, record)
      inflight.delete(key)
    }
  }
}

/**
 * Main's timers suspend across sleep; wall-clock age releases admitted readers
 * even after invalidation. Size-cap eviction still falls back to its own timer.
 */
export function expireOverdueInflight(now: number): void {
  let overdue: InflightRecord[] | undefined
  for (const records of [inflight, retired]) {
    for (const record of records.values()) {
      if (now - record.startedAt >= HOSTED_REVIEW_LOOKUP_DEADLINE_MS) {
        overdue ??= []
        overdue.push(record)
      }
    }
  }
  for (const record of overdue ?? []) {
    record.expire()
  }
}

export function trackInflight(key: string, record: InflightRecord): void {
  inflight.set(key, record)
  while (inflight.size > MAX_INFLIGHT_LOOKUPS) {
    const oldest = inflight.keys().next().value
    if (oldest === undefined) {
      break
    }
    // Eviction bounds this index; the request's own deadline still releases its callers.
    inflight.delete(oldest)
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewInflightLookupsForTests(): void {
  inflight.clear()
  retired.clear()
}
