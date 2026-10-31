import type { HostedReviewForBranchOutcome } from '../../shared/hosted-review'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  MAX_INFLIGHT_LOOKUPS
} from './hosted-review-refresh-pacing'

declare const inflightTokenBrand: unique symbol

/** Identity token for one lookup; only ever compared by reference. */
export type InflightToken = { readonly [inflightTokenBrand]?: never }

export type InflightRecord = {
  /** Identity, so a detached lookup can only ever clear its own entry. */
  token: InflightToken
  startedAt: number
  promise: Promise<HostedReviewForBranchOutcome>
  /** Releases the callers and unpins the branch; idempotent. */
  expire: () => void
}

const inflight = new Map<string, InflightRecord>()
/** Invalidation retires joinable ownership without cancelling work. Admission bounds outstanding tokens, including callers still awaiting retired requests. */
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

export function retireInflightLookup(key: string): void {
  const record = inflight.get(key)
  if (record) {
    retired.set(record.token, record)
    inflight.delete(key)
  }
}

/** Retire matching owners without failing their callers. */
export function retireInflightWithPrefix(prefix: string): void {
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      retireInflightLookup(key)
    }
  }
}

/** Sweep tracked current/retired owners by wall-clock age because sleep suspends timers. Size-evicted records lose this sweep and rely on their own timer. */
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
    // Eviction bounds memory without expiring callers, but loses wall-clock sweeping; keep the cap above realistic concurrency.
    inflight.delete(oldest)
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewInflightLookupsForTests(): void {
  inflight.clear()
  retired.clear()
}
