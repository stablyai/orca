import type { OrcaVmRecipe } from '../../shared/types'
import type { PluginService } from './plugin-service'

export async function getApprovedPluginVmRecipes(
  pluginService?: PluginService
): Promise<OrcaVmRecipe[]> {
  if (!pluginService) {
    return []
  }
  await pluginService.whenReady()
  return pluginService.contentPacks.vmRecipes.list().map(({ recipe }) => recipe)
}
