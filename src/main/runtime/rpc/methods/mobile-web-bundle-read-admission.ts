import type { RpcContext } from '../core'

/** Enough for a client to keep the pipe full without letting one phone own the disk. */
export const MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS = 4

const activeReads = new Map<string, number>()

/** Tests own the process, so they own the counters; nothing in the app may call this. */
export function resetMobileWebBundleReadAdmissionForTests(): void {
  activeReads.clear()
}

/** Expose bucket count only for tests proving no per-socket token retention. */
export function mobileWebBundleReadBucketCountForTests(): number {
  return activeReads.size
}

/** Prefer E2EE connectionId, then device token for plain-WebSocket phones; in-process callers have neither. */
export function mobileWebBundleReadBucket(ctx: RpcContext): string {
  return ctx.connectionId ?? ctx.clientId ?? 'local'
}

/** A slot in the bucket's budget, or null when it is already full. Release exactly once. */
export function acquireMobileWebBundleReadSlot(bucket: string): (() => void) | null {
  const active = activeReads.get(bucket) ?? 0
  if (active >= MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS) {
    return null
  }
  activeReads.set(bucket, active + 1)
  return () => {
    const remaining = (activeReads.get(bucket) ?? 1) - 1
    // Drop empty buckets so reconnect churn cannot retain socket ids or pairing tokens forever.
    if (remaining > 0) {
      activeReads.set(bucket, remaining)
    } else {
      activeReads.delete(bucket)
    }
  }
}
