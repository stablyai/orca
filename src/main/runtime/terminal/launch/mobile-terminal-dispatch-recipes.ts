import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'

type Launch = { launchConfig?: SleepingAgentLaunchConfig; launchAgent?: TuiAgent }
type Dispatch = Launch & { connectionId: string | null; recordedAt: number }
const DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export class MobileTerminalDispatchRecipes {
  private readonly byHandle = new Map<string, Dispatch>()

  record(handle: string, connectionId: string | null, launch: Launch, preserve: boolean): void {
    const now = Date.now()
    for (const [key, recipe] of this.byHandle) {
      if (now - recipe.recordedAt < DISPATCH_RECIPE_TTL_MS) {
        break
      }
      this.byHandle.delete(key)
    }
    if (this.byHandle.has(handle)) {
      // Reattaching an ambiguous history create must preserve its original launch recipe.
      if (preserve) {
        return
      }
      this.byHandle.delete(handle)
    } else if (this.byHandle.size >= 4096) {
      throw new Error('runtime_unavailable')
    }
    this.byHandle.set(handle, {
      ...launch,
      launchConfig: launch.launchConfig && copySleepingAgentLaunchConfig(launch.launchConfig),
      connectionId,
      recordedAt: now
    })
  }

  get(handle: string): Dispatch | undefined {
    const recipe = this.byHandle.get(handle)
    if (recipe && Date.now() - recipe.recordedAt >= DISPATCH_RECIPE_TTL_MS) {
      this.byHandle.delete(handle)
      return undefined
    }
    return recipe
  }

  delete(handle: string): void {
    this.byHandle.delete(handle)
  }
}
