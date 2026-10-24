import { hashPluginTree } from './plugin-content-hash'

export type HashAddressedPluginContent = {
  rootDir: string
  contentHash: string | null
}

export type PluginContentIntegrityResult = { ok: true } | { ok: false; error: string }

/** Whether a computed tree hash is the recorded identity. Early P0 installs used a
 * 128-bit SHA-256 prefix as the directory name; new installs use the full digest. */
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

/** Deduplicates the first lazy verification for each discovered install. */
export class PluginContentVerifier {
  private readonly verifications = new Map<string, Promise<PluginContentIntegrityResult>>()

  clear(): void {
    this.verifications.clear()
  }

  async verify(plugin: HashAddressedPluginContent & { pluginKey: string }): Promise<void> {
    // Why: a refresh can replace one same-key install while its old hash is
    // still being verified. Cache by immutable content identity, never key.
    const identity = JSON.stringify([plugin.pluginKey, plugin.rootDir, plugin.contentHash])
    let verification = this.verifications.get(identity)
    if (!verification) {
      verification = verifyHashAddressedPluginContent(plugin)
      this.verifications.set(identity, verification)
    }
    const result = await verification
    if (!result.ok) {
      this.verifications.delete(identity)
      throw new Error(`plugin ${plugin.pluginKey} failed integrity verification: ${result.error}`)
    }
  }

  /** Uncached integrity check for code about to run; bytes may have changed since `verify`. */
  async verifyNow(plugin: HashAddressedPluginContent & { pluginKey: string }): Promise<void> {
    const result = await verifyHashAddressedPluginContent(plugin)
    if (!result.ok) {
      throw new Error(`plugin ${plugin.pluginKey} failed integrity verification: ${result.error}`)
    }
  }
}
