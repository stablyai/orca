import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { RuntimeClientSourceControlAi } from './runtime-client-settings-shape'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { SOURCE_CONTROL_LAUNCH_ACTION_IDS } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'

export function projectSourceControlLaunchRecipes(
  settings: Partial<Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>>
): RuntimeClientSourceControlAi {
  const normalized = normalizeSourceControlAiSettings(
    settings.sourceControlAi,
    settings.commitMessageAi
  )
  const { actions } = normalized
  return {
    enabled: normalized.enabled,
    actions: Object.fromEntries(
      SOURCE_CONTROL_LAUNCH_ACTION_IDS.flatMap((actionId) => {
        const recipe = actions?.[actionId]
        return recipe ? [[actionId, recipe]] : []
      })
    )
  }
}
