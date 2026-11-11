import { createHash } from 'node:crypto'
import { pluginTreeHashMatches } from '../plugin-content-integrity'
import { hashPluginTree } from '../plugin-content-hash'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'

/** How long one tree verification vouches for the sub-resources a document loads. */
const ASSET_VERIFICATION_REUSE_MS = 10_000
/** A real navigation re-verifies, but never more often than this per plugin tree. */
const NAVIGATION_REVERIFY_MIN_MS = 2_000

/** Per-file sha256 of a verified tree, keyed by `/`-separated path; null for mutable dev trees. */
export type PluginFrameFileDigests = ReadonlyMap<string, string> | null

/** Hashes the tree once and returns its per-file digests; throws when it no longer matches. */
export type PluginFrameTreeVerifier = (
  plugin: ValidDiscoveredPlugin
) => Promise<PluginFrameFileDigests>

export const verifyPluginFrameTree: PluginFrameTreeVerifier = async (plugin) => {
  if (plugin.contentHash === null) {
    return null
  }
  const fileDigests = new Map<string, string>()
  const tree = await hashPluginTree(plugin.rootDir, { fileDigests })
  if (!tree.ok) {
    throw new Error(tree.error)
  }
  if (!pluginTreeHashMatches(tree.hash, plugin.contentHash)) {
    throw new Error(`content hash mismatch (expected ${plugin.contentHash}, got ${tree.hash})`)
  }
  return fileDigests
}

/**
 * One session's view of its plugin tree: a navigation re-verifies (at most every 2 s), anything
 * else reuses a check from the last 10 s, and concurrent requests share one hash.
 */
export function createPluginFrameIntegrity(
  verifyTree: PluginFrameTreeVerifier,
  now: () => number
): (plugin: ValidDiscoveredPlugin, isNavigation: boolean) => Promise<PluginFrameFileDigests> {
  const verified = new Map<string, { at: number; digests: PluginFrameFileDigests }>()
  const inFlight = new Map<string, Promise<PluginFrameFileDigests>>()
  return async (plugin, isNavigation) => {
    const identity = JSON.stringify([plugin.pluginKey, plugin.rootDir, plugin.contentHash])
    const last = verified.get(identity)
    const reuseMs = isNavigation ? NAVIGATION_REVERIFY_MIN_MS : ASSET_VERIFICATION_REUSE_MS
    if (last && now() - last.at < reuseMs) {
      return last.digests
    }
    let pending = inFlight.get(identity)
    if (!pending) {
      verified.delete(identity)
      pending = verifyTree(plugin).finally(() => inFlight.delete(identity))
      inFlight.set(identity, pending)
    }
    const digests = await pending
    verified.set(identity, { at: now(), digests })
    return digests
  }
}

/** Served bytes must be the bytes the tree hash covered; a missing digest means a new file. */
export function matchesVerifiedDigest(
  digests: PluginFrameFileDigests,
  relativePath: string,
  bytes: Uint8Array
): boolean {
  if (digests === null) {
    return true
  }
  const expected = digests.get(relativePath)
  return expected !== undefined && createHash('sha256').update(bytes).digest('hex') === expected
}
