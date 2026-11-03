import { createHash } from 'node:crypto'
import type { PluginSidebarCardContribution } from '../../../shared/plugins/contributions/plugin-sidebar-card-contribution'
import {
  parsePluginSidebarCardArtifact,
  PLUGIN_SIDEBAR_CARD_MAX_BYTES,
  type PluginSidebarCardRegistration
} from '../../../shared/plugins/artifacts/plugin-sidebar-card-artifact'
import { readContainedPluginArtifactText } from '../plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../plugin-content-integrity'

export function createPluginSidebarCardRegistry(contentVerifier: PluginContentVerifier) {
  return new PluginArtifactPackRegistry<
    PluginSidebarCardContribution,
    PluginSidebarCardRegistration
  >({
    contentVerifier,
    contributions: (plugin) => plugin.manifest.contributes.sidebarCards,
    load: async (plugin, contribution) => {
      const text = await readContainedPluginArtifactText(
        plugin.rootDir,
        contribution.template,
        PLUGIN_SIDEBAR_CARD_MAX_BYTES
      )
      try {
        return {
          id: `plugin:${plugin.pluginKey}/${contribution.id}`,
          revision: createHash('sha256').update(text).digest('hex').slice(0, 32),
          pluginKey: plugin.pluginKey,
          pluginName: plugin.manifest.name,
          label: contribution.title,
          ...(contribution.description ? { description: contribution.description } : {}),
          template: parsePluginSidebarCardArtifact(text)
        }
      } catch (error) {
        throw new Error(
          `sidebar card "${contribution.id}" is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  })
}
