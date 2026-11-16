import type { AppState } from '../store/types'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'

type AppRootSurfaceSettingsState = Pick<AppState, 'settings'>

export function selectAppRootSurfaceVoiceEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.voice?.enabled === true
}

export function selectAppRootSurfacePetEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.experimentalPet === true
}

export function selectAppRootSurfaceTelemetryOptedIn(
  state: AppRootSurfaceSettingsState
): boolean | 'unknown' {
  return state.settings?.telemetry?.optedIn ?? 'unknown'
}

export function shouldMountUpdateCardForStatus(status: UpdateStatus): boolean {
  if (status.state === 'idle') {
    return false
  }
  if (status.state === 'checking' || status.state === 'not-available') {
    return status.userInitiated === true
  }
  return true
}
