import { hasDeclarativePluginContributions } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import { hashPluginTree } from './plugin-content-hash'
import { pluginTreeHashMatches } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

/** Declarative bytes execute later, so every read must still match the tree
 * identity the user reviewed rather than a cached discovery-time snapshot. */
export async function verifyDeclarativePluginContent(plugin: ValidDiscoveredPlugin): Promise<void> {
  if (!hasDeclarativePluginContributions(plugin.manifest)) {
    return
  }
  if (!plugin.consentContentHash) {
    throw new Error(`plugin ${plugin.pluginKey} has no declarative consent content identity`)
  }
  const actual = await hashPluginTree(plugin.rootDir)
  if (!actual.ok) {
    throw new Error(`plugin ${plugin.pluginKey} declarative content is unreadable: ${actual.error}`)
  }
  if (!pluginTreeHashMatches(actual.hash, plugin.consentContentHash)) {
    throw new Error(`plugin ${plugin.pluginKey} declarative content changed since it was reviewed`)
  }
}
