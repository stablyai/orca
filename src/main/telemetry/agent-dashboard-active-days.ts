import {
  isAgentDashboardSurface,
  type AgentDashboardSurface
} from '../../shared/telemetry/schemas/telemetry-agent-dashboard-event-schemas'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { Store } from '../persistence/loading-store/store'

/** UTC day each dashboard surface was last reported this session; caps the event at once a day. */
export const trackedDashboardActiveDays = new Map<AgentDashboardSurface, number>()

export function hasTrackedAgentDashboardActiveToday(props: unknown): boolean {
  if (!props || typeof props !== 'object' || !('surface' in props)) {
    return false
  }
  const surface = props.surface
  return (
    isAgentDashboardSurface(surface) &&
    (trackedDashboardActiveDays.get(surface) ?? -1) >= Math.floor(Date.now() / 86_400_000)
  )
}

export function saveDashboardActiveDay(
  store: Store,
  settings: GlobalSettings,
  surface: AgentDashboardSurface,
  day: number
): void {
  if (!settings.telemetry) {
    return
  }
  trackedDashboardActiveDays.set(surface, day)
  try {
    store.updateSettings({
      telemetry: {
        ...settings.telemetry,
        agentDashboardActiveDays: { ...settings.telemetry.agentDashboardActiveDays, [surface]: day }
      }
    })
  } catch (err) {
    console.warn('[telemetry] failed to persist dashboard daily usage limit', err)
  }
}
