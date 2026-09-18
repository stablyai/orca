import type { RpcContext } from '../core'

/** Enough for a client to keep the pipe full without letting one phone own the disk. */
export const MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS = 4

const activeReads = new Map<string, number>()

/** Tests own the process, so they own the counters; nothing in the app may call this. */
export function resetMobileWebBundleReadAdmissionForTests(): void {
  activeReads.clear()
}

/**
 * The bucket a chunk read is charged to. `connectionId` is set only for E2EE mobile sockets, so
 * keying on it alone would leave a plain-WebSocket phone in one shared unbounded bucket; the device
 * token still names one client. An in-process caller has neither and is not the caller this bounds.
 */
export function mobileWebBundleReadBucket(ctx: RpcContext): string {
  return ctx.connectionId ?? ctx.clientId ?? 'local'
}

/**
 * A slot in the bucket's budget, or null when it is already full. The returned release is
 * idempotent, so a caller that releases in a `finally` after an earlier throw cannot double-credit.
 */
export function acquireMobileWebBundleReadSlot(bucket: string): (() => void) | null {
  const active = activeReads.get(bucket) ?? 0
  if (active >= MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS) {
    return null
  }
  activeReads.set(bucket, active + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (activeReads.get(bucket) ?? 1) - 1
    // Dropping the key at zero is what keeps this from growing one entry per connection forever.
    if (remaining > 0) {
      activeReads.set(bucket, remaining)
    } else {
      activeReads.delete(bucket)
    }
  }
}
