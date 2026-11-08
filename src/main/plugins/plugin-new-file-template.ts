import { readPluginNewFileTemplate } from './plugin-artifact-validation'
import type { PluginService } from './plugin-service'

/** A new file's starting text: its template, or empty. Null when the plugin is off or lacks it,
 *  so a stale menu item never writes a file for a plugin the user turned off. */
export async function readApprovedPluginNewFileTemplate(
  service: Pick<PluginService, 'findApprovedPlugin'>,
  pluginKey: string,
  newFileId: string
): Promise<string | null> {
  const plugin = service.findApprovedPlugin(pluginKey)
  const newFile = plugin?.manifest.contributes.newFiles.find((entry) => entry.id === newFileId)
  if (!plugin || !newFile) {
    return null
  }
  return newFile.template === undefined
    ? ''
    : readPluginNewFileTemplate(plugin.rootDir, newFile.template)
}
