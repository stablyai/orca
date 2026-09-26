import type { AppState } from '../store/types'
import { normalizeSleepyModeIdleMinutes } from '../../../shared/sleepy-mode-settings'

type AppRootSurfaceSettingsState = Pick<AppState, 'settings'>

export function selectAppRootSurfaceVoiceEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.voice?.enabled === true
}

export function selectAppRootSurfacePetEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.experimentalPet === true
}

export function selectAppRootSurfaceSleepyModeAutoStart(
  state: AppRootSurfaceSettingsState
): boolean {
  return normalizeSleepyModeIdleMinutes(state.settings?.sleepyModeIdleMinutes) > 0
}

export function selectAppRootSurfaceTelemetryOptedIn(
  state: AppRootSurfaceSettingsState
): boolean | 'unknown' {
  return state.settings?.telemetry?.optedIn ?? 'unknown'
}
