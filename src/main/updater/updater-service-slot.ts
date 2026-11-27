import type { UpdateStatus } from '../../shared/updater/update-status-types'
import type * as UpdaterServiceModule from './updater-service'

export type RegisteredUpdaterService = {
  getUpdateStatus: () => UpdateStatus
  isQuittingForUpdate: () => boolean
  isNativeUpdateInstallUnderWay: () => boolean
  applyTeamPolicyBeforeQuit: () => void
  applyAutomaticUpdatesSetting: (enabled: boolean | undefined) => void
}

let registered: RegisteredUpdaterService | null = null
let serviceModulePromise: Promise<typeof UpdaterServiceModule> | null = null

export function registerUpdaterService(service: RegisteredUpdaterService): void {
  registered = service
}

export function loadUpdaterService(): Promise<typeof UpdaterServiceModule> {
  return (serviceModulePromise ??= import('./updater-service'))
}

export function getLoadedUpdateStatus(): UpdateStatus {
  return registered ? registered.getUpdateStatus() : { state: 'idle' }
}

export function isQuittingForUpdate(): boolean {
  return registered?.isQuittingForUpdate() ?? false
}

export function isNativeUpdateInstallUnderWay(): boolean {
  return registered?.isNativeUpdateInstallUnderWay() ?? false
}

export function applyTeamPolicyBeforeQuit(): void {
  registered?.applyTeamPolicyBeforeQuit()
}

export function applyAutomaticUpdatesSetting(enabled: boolean | undefined): void {
  if (enabled === true) {
    registered?.applyAutomaticUpdatesSetting(true)
  }
}
