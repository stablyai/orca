import { hasInstructionalPluginContributions } from '../../shared/plugins/plugin-consent-fingerprint'
import { hashPluginTree } from './plugin-content-hash'
import { pluginTreeHashMatches } from './plugin-content-integrity'
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
  if (!pluginTreeHashMatches(actual.hash, plugin.consentContentHash)) {
    throw new Error(
      `plugin ${plugin.pluginKey} instructional content changed since it was reviewed`
    )
  }
}
