import { hasInstructionalPluginContributions } from '../../shared/plugins/plugin-consent-fingerprint'
import { hashPluginTree } from './plugin-content-hash'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

/** Instructional bytes execute later, so every read must still match the tree
 * identity the user reviewed rather than a cached discovery-time snapshot. */
export async function verifyInstructionalPluginContent(
  plugin: ValidDiscoveredPlugin
): Promise<void> {
  if (!hasInstructionalPluginContributions(plugin.manifest)) {
    return
  }
  if (!plugin.consentContentHash) {
    throw new Error(`plugin ${plugin.pluginKey} has no instructional consent content identity`)
  }
  const actual = await hashPluginTree(plugin.rootDir)
  if (!actual.ok) {
    throw new Error(
      `plugin ${plugin.pluginKey} instructional content is unreadable: ${actual.error}`
    )
  }
  const matches =
    actual.hash === plugin.consentContentHash ||
    (plugin.consentContentHash.length === 32 && actual.hash.startsWith(plugin.consentContentHash))
  if (!matches) {
    throw new Error(
      `plugin ${plugin.pluginKey} instructional content changed since it was reviewed`
    )
  }
}
