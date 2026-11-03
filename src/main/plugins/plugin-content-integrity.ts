import { hashPluginTree } from './plugin-content-hash'

export type HashAddressedPluginContent = {
  rootDir: string
  contentHash: string | null
}

export type PluginContentIntegrityResult = { ok: true } | { ok: false; error: string }

/** Accept legacy 128-bit SHA-256 directory prefixes alongside current full digests. */
export function pluginTreeHashMatches(actual: string, expected: string): boolean {
  return actual === expected || (expected.length === 32 && actual.startsWith(expected))
}

/** Dev trees are intentionally mutable; installed hash-addressed trees are not. */
export async function verifyHashAddressedPluginContent(
  plugin: HashAddressedPluginContent
): Promise<PluginContentIntegrityResult> {
  if (plugin.contentHash === null) {
    return { ok: true }
  }
  const actual = await hashPluginTree(plugin.rootDir)
  if (!actual.ok) {
    return { ok: false, error: actual.error }
  }
  if (!pluginTreeHashMatches(actual.hash, plugin.contentHash)) {
    return {
      ok: false,
      error: `content hash mismatch (expected ${plugin.contentHash}, got ${actual.hash})`
    }
  }
  return { ok: true }
}

// Why no cache: a hash costs ~1 ms for typical plugin trees, and bytes changed after a first
// load must be caught on the next one. Only checks already in flight are shared.
export class PluginContentVerifier {
  private readonly inFlight = new Map<string, Promise<PluginContentIntegrityResult>>()

  /** Re-hashes the tree on every load; concurrent loads of the same tree share one hash. */
  async verify(plugin: HashAddressedPluginContent & { pluginKey: string }): Promise<void> {
    const identity = JSON.stringify([plugin.pluginKey, plugin.rootDir, plugin.contentHash])
    let verification = this.inFlight.get(identity)
    if (!verification) {
      verification = verifyHashAddressedPluginContent(plugin).finally(() => {
        this.inFlight.delete(identity)
      })
      this.inFlight.set(identity, verification)
    }
    const result = await verification
    if (!result.ok) {
      throw new Error(`plugin ${plugin.pluginKey} failed integrity verification: ${result.error}`)
    }
  }

  /** Unshared check for code about to run: a hash started before this call must not vouch for it. */
  async verifyNow(plugin: HashAddressedPluginContent & { pluginKey: string }): Promise<void> {
    const result = await verifyHashAddressedPluginContent(plugin)
    if (!result.ok) {
      throw new Error(`plugin ${plugin.pluginKey} failed integrity verification: ${result.error}`)
    }
  }
}
