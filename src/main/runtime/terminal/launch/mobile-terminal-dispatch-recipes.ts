import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

const OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export type MobileTerminalDispatchRecipe = {
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  connectionId: string | null
  recordedAt: number
}

export function pruneMobileTerminalDispatchRecipes(
  recipes: Map<string, MobileTerminalDispatchRecipe>
): void {
  const now = Date.now()
  for (const [handle, recipe] of recipes) {
    if (now - recipe.recordedAt >= OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS) {
      recipes.delete(handle)
    }
  }
}
