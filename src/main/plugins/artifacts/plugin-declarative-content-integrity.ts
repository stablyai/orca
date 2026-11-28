import { hasDeclarativePluginContributions } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import {
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifest
} from '../../../shared/plugins/manifest/plugin-manifest'
import { hashPluginTree, type PluginTreeHashResult } from './plugin-content-hash'
import { pluginTreeHashMatches } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'

/** The bytes approval of declarative points names. A dev folder binds only the manifest (which holds
 *  shortcuts and MCP servers) and its recipe files: its worker and panels are the author's working
 *  copy, and binding them would ask for approval again on every save. */
export function hashDeclarativePluginContent(
  rootDir: string,
  manifest: PluginManifest,
  isDev: boolean
): Promise<PluginTreeHashResult> {
  if (!isDev) {
    return hashPluginTree(rootDir)
  }
  const bound = [
    PLUGIN_MANIFEST_FILENAME,
    ...manifest.contributes.vmRecipes.map(({ path }) => path)
  ]
  return hashPluginTree(rootDir, {
    devFolder: true,
    only: new Set(bound.map((path) => path.replaceAll('\\', '/').toLowerCase()))
  })
}

/** Declarative bytes execute later, so every read must still match the content identity the
 *  user reviewed rather than a cached discovery-time snapshot. */
export async function verifyDeclarativePluginContent(plugin: ValidDiscoveredPlugin): Promise<void> {
  if (!hasDeclarativePluginContributions(plugin.manifest)) {
    return
  }
  if (!plugin.consentContentHash) {
    throw new Error(`plugin ${plugin.pluginKey} has no declarative consent content identity`)
  }
  const actual = await hashDeclarativePluginContent(plugin.rootDir, plugin.manifest, plugin.isDev)
  if (!actual.ok) {
    throw new Error(`plugin ${plugin.pluginKey} declarative content is unreadable: ${actual.error}`)
  }
  if (!pluginTreeHashMatches(actual.hash, plugin.consentContentHash)) {
    throw new Error(`plugin ${plugin.pluginKey} declarative content changed since it was reviewed`)
  }
}
