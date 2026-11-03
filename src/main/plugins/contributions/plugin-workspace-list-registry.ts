import { createHash } from 'node:crypto'
import type { PluginWorkspaceListContribution } from '../../../shared/plugins/contributions/plugin-workspace-list-contribution'
import {
  parsePluginWorkspaceListArtifact,
  PLUGIN_WORKSPACE_LIST_MAX_BYTES,
  type PluginWorkspaceListRegistration
} from '../../../shared/plugins/artifacts/plugin-workspace-list-artifact'
import { readContainedPluginArtifactText } from '../plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../plugin-content-integrity'

export function createPluginWorkspaceListRegistry(contentVerifier: PluginContentVerifier) {
  return new PluginArtifactPackRegistry<
    PluginWorkspaceListContribution,
    PluginWorkspaceListRegistration
  >({
    contentVerifier,
    contributions: (plugin) => plugin.manifest.contributes.workspaceLists,
    load: async (plugin, contribution) => {
      const text = await readContainedPluginArtifactText(
        plugin.rootDir,
        contribution.arrangement,
        PLUGIN_WORKSPACE_LIST_MAX_BYTES
      )
      try {
        return {
          id: `plugin:${plugin.pluginKey}/${contribution.id}`,
          revision: createHash('sha256').update(text).digest('hex').slice(0, 32),
          pluginKey: plugin.pluginKey,
          pluginName: plugin.manifest.name,
          label: contribution.title,
          ...(contribution.description ? { description: contribution.description } : {}),
          arrangement: parsePluginWorkspaceListArtifact(text)
        }
      } catch (error) {
        throw new Error(
          `workspace list "${contribution.id}" is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  })
}
