import { CapabilityProbeCache } from '../../../shared/concurrency/capability-probe-cache'

// Retry missing RPCs periodically so in-place zcode upgrades recover without restarting Orca.
export const ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
export const ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES = 64

/**
 * Per-connection probe bookkeeping keyed by method name: one app-server child either answers an
 * optional method or maps it to -32601, and concurrent callers await the same probe.
 */
export function createZcodeAppServerCapabilityCache(): CapabilityProbeCache<string> {
  return new CapabilityProbeCache(
    ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS,
    ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES
  )
}
