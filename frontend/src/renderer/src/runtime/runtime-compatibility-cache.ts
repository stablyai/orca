// src/renderer/src/runtime/runtime-compatibility-cache.ts
// Runtime-environment compatibility/status cache — split out of
// runtime-rpc-client.ts (max-lines budget). Depends only on
// runtime-rpc-result.ts (not the rest of runtime-rpc-client.ts) to avoid an
// import cycle, since callRuntimeRpc (still in runtime-rpc-client.ts) calls
// ensureRuntimeEnvironmentCompatible. Re-exported from runtime-rpc-client.ts
// unchanged so no external call site needs to change its import path.
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000
// Why: a saved environment can restart into a different Orca version without
// changing ids; capability verdicts must eventually follow that version change.
const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  // True only once status.get settled and proved compatible. Stays false while
  // the probe is in flight, so a recovery clear can drop a doomed pending probe.
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
}

const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

export async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: { timeoutMs?: number; reuseRecentCompatibilityFailure?: boolean } = {}
): Promise<void> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    await cached.check
    return
  }
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible: false,
    status: null,
    statusCheckedAt: null
  }
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'status.get',
      timeoutMs: options.timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(environmentId, entry)
  try {
    await check
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      entry.provenCompatible = true
    }
  } catch (error) {
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      // Why: startup asks each remote for repos, groups, then folders; an
      // offline runtime should pay one timeout during that burst, not three.
      entry.failedAt = Date.now()
    }
    throw error
  }
}

function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: { reuseRecentCompatibilityFailure?: boolean }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (!cached) {
    return null
  }
  if (
    cached.failedAt !== null &&
    Date.now() - cached.failedAt >= RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS
  ) {
    runtimeCompatibilityChecks.delete(environmentId)
    return null
  }
  if (cached.failedAt !== null && options.reuseRecentCompatibilityFailure !== true) {
    return null
  }
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, cached)
  return cached
}

function rememberRuntimeEnvironmentCompatibility(
  environmentId: string,
  entry: RuntimeCompatibilityCacheEntry
): void {
  // Why: saved/removed remote runtimes can churn through unique ids in long
  // renderer sessions; compatibility cache entries should not grow forever.
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, entry)
  while (runtimeCompatibilityChecks.size > RUNTIME_COMPATIBILITY_CACHE_MAX) {
    const oldest = runtimeCompatibilityChecks.keys().next().value
    if (oldest === undefined) {
      break
    }
    runtimeCompatibilityChecks.delete(oldest)
  }
}

// Why: a live status.get answer proves any cached compatibility verdict that is
// not a settled success is stale. Drop settled failures AND still-pending probes
// (a probe queued on the dropped connection is doomed, and a reachability-
// triggered refresh must not coalesce onto it) so the refresh re-probes. Only
// proven-compatible successes stay cached.
export function clearRecentRuntimeCompatibilityFailure(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  const cached = runtimeCompatibilityChecks.get(trimmed)
  if (cached && !cached.provenCompatible) {
    runtimeCompatibilityChecks.delete(trimmed)
  }
}

export function clearRuntimeCompatibilityCache(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    runtimeCompatibilityChecks.delete(trimmed)
    return
  }
  runtimeCompatibilityChecks.clear()
}

export function markRuntimeEnvironmentCompatible(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  rememberRuntimeEnvironmentCompatibility(trimmed, {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible: true,
    status: null,
    statusCheckedAt: null
  })
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number
): Promise<RuntimeStatus> {
  const trimmed = environmentId.trim()
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible: false,
    status: null,
    statusCheckedAt: null
  }
  // Why: publish the in-flight probe before awaiting so concurrent cold-cache
  // capability lookups coalesce onto this one status.get (via the cache-hit path
  // in runtimeEnvironmentSupportsCapability) instead of each firing their own.
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: trimmed,
      method: 'status.get',
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.provenCompatible = true
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
  try {
    await check
  } catch (error) {
    // Why: this probe always re-fetches, so a failure must not linger as a
    // cached verdict; drop the entry so the next call re-probes cleanly.
    if (runtimeCompatibilityChecks.get(trimmed) === entry) {
      runtimeCompatibilityChecks.delete(trimmed)
    }
    throw error
  }
  if (!entry.status) {
    // Unreachable: a resolved probe always assigns status; narrows the type.
    throw new Error('Runtime status probe resolved without a status.')
  }
  return entry.status
}

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<boolean> {
  const trimmed = environmentId.trim()
  const cached = runtimeCompatibilityChecks.get(trimmed)
  // Why: callRuntimeRpc re-probes after failed status checks by default. Capability
  // lookups must not pin to a rejected cache promise or they block recovery for
  // the full failure TTL even though the next RPC would re-probe successfully.
  if (cached && cached.failedAt === null) {
    try {
      await cached.check
      if (
        runtimeCompatibilityChecks.get(trimmed) === cached &&
        cached.status &&
        cached.statusCheckedAt !== null &&
        Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS
      ) {
        const supported = cached.status.capabilities?.includes(capability) === true
        if (!supported) {
          // Why: an unsupported verdict must not survive a remote upgrade. The
          // next explicit retry re-probes instead of pinning the old capability set.
          runtimeCompatibilityChecks.delete(trimmed)
        }
        return supported
      }
    } catch {
      // Fall through to a fresh status.get that refreshes the cache.
    }
  }
  const status = await getRuntimeEnvironmentStatus(trimmed, timeoutMs)
  const supported = status.capabilities?.includes(capability) === true
  if (!supported && runtimeCompatibilityChecks.get(trimmed)?.status === status) {
    runtimeCompatibilityChecks.delete(trimmed)
  }
  return supported
}

export async function assertRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability,
  message: string,
  timeoutMs?: number
): Promise<void> {
  const status = await getRuntimeEnvironmentStatus(environmentId, timeoutMs)
  if (!status.capabilities?.includes(capability)) {
    throw new Error(message)
  }
}

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}
