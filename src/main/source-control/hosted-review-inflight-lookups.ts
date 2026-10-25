import type { HostedReviewInfo } from '../../shared/hosted-review'
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
  promise: Promise<HostedReviewInfo | null>
  /** Releases the callers and unpins the branch; idempotent. */
  expire: () => void
}

const inflight = new Map<string, InflightRecord>()
/**
 * Owners an invalidation took off their key. They keep running — nothing here
 * can cancel a lookup — but no new reader may join them, which is what stops a
 * post-invalidation read from waiting out a stale request's deadline.
 *
 * Admission bounds these to two per key across at most 1,000 unsettled keys, so
 * this map cannot outgrow the lookups already counted as in progress.
 */
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

/** Takes every owner under `prefix` off its key, without failing it. */
export function retireInflightWithPrefix(prefix: string): void {
  for (const [key, record] of inflight) {
    if (key.startsWith(prefix)) {
      retired.set(record.token, record)
      inflight.delete(key)
    }
  }
}

/**
 * Expires records that outlived the deadline without their timer firing. Main's
 * timers are suspended across a system sleep, so wall-clock age — not
 * `setTimeout` alone — is what actually bounds how long a branch stays pinned.
 * Retired owners are swept too: their readers are gone, but their own callers
 * still need releasing.
 *
 * The guarantee covers tracked records only: one the size cap evicted is in
 * neither map and falls back to its own suspended timer.
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
    // Why: drop the record without expiring it — its own deadline still releases
    // its callers, and evicting is about memory, not about failing. It does
    // forfeit the sweep above, so the cap must stay far above realistic
    // concurrency: below it, sleep-suspended timers are all an evicted record's
    // callers have left.
    inflight.delete(oldest)
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewInflightLookupsForTests(): void {
  inflight.clear()
  retired.clear()
}
