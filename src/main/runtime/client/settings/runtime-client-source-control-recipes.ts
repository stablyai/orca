import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { SOURCE_CONTROL_LAUNCH_ACTION_IDS } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { RuntimeClientSourceControlAi } from './runtime-client-settings-shape'

// A paired client's AI buttons start these actions' agents, and must honour the
// agent saved for each one as the desktop does. Absent on older hosts.
export function projectSourceControlLaunchRecipes(
  settings: Partial<Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>>
): RuntimeClientSourceControlAi {
  const { enabled, actions } = normalizeSourceControlAiSettings(
    settings.sourceControlAi,
    settings.commitMessageAi
  )
  return {
    enabled,
    actions: Object.fromEntries(
      SOURCE_CONTROL_LAUNCH_ACTION_IDS.flatMap((actionId) => {
        const recipe = actions?.[actionId]
        return recipe ? [[actionId, recipe]] : []
      })
    )
  }
}
