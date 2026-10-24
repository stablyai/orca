// Why: kept free of the electron import so the grant rules can be tested without a session.

/**
 * Chromium 150 asks for one of three names depending on the target: `local-network-access` and
 * `local-network` for private-range and `.local` hosts, `loopback-network` for 127.0.0.1 and ::1.
 * Orca asks once for all three, so a single grant answers every name.
 */
const LOCAL_NETWORK_PERMISSIONS: ReadonlySet<string> = new Set([
  'local-network-access',
  'local-network',
  'loopback-network'
])

export function isLocalNetworkPermission(permission: string): boolean {
  return LOCAL_NETWORK_PERMISSIONS.has(permission)
}

function httpsOrigin(rawUrlOrOrigin: string | null | undefined): string | null {
  if (!rawUrlOrOrigin) {
    return null
  }
  try {
    const url = new URL(rawUrlOrOrigin)
    // Why: http and opaque origins (data:, sandboxed frames) can be forged or hijacked on the way,
    // so they never get to reach services on this device.
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * The origin a local-network grant belongs to, or null when the request is not eligible. A frame
 * only qualifies when it is the top-level page's own origin, so an embedded third-party frame never
 * gets more than the page that embeds it.
 */
export function eligibleLocalNetworkOrigin(
  requesting: string | null | undefined,
  topLevel: string | null | undefined
): string | null {
  const origin = httpsOrigin(requesting)
  return origin !== null && origin === httpsOrigin(topLevel) ? origin : null
}

// Why in memory only: persistence and a Settings surface to review and revoke grants are a later step.
const grantedOriginsByPartition = new Map<string, Set<string>>()
// Why: bumped on every clear, so an answer to a prompt opened before teardown cannot recreate a grant.
const grantEpochByPartition = new Map<string, number>()

export function localNetworkGrantEpoch(partition: string): number {
  return grantEpochByPartition.get(partition) ?? 0
}

export function hasLocalNetworkGrant(partition: string, origin: string): boolean {
  return grantedOriginsByPartition.get(partition)?.has(origin) ?? false
}

/** Records a grant unless the partition was cleared since `epoch` was read; returns whether it did. */
export function grantLocalNetworkAccess(partition: string, origin: string, epoch: number): boolean {
  if (epoch !== localNetworkGrantEpoch(partition)) {
    return false
  }
  const origins = grantedOriginsByPartition.get(partition) ?? new Set<string>()
  origins.add(origin)
  grantedOriginsByPartition.set(partition, origins)
  return true
}

export function clearLocalNetworkGrants(partition: string): void {
  grantedOriginsByPartition.delete(partition)
  grantEpochByPartition.set(partition, localNetworkGrantEpoch(partition) + 1)
}
