import type { BrowserWindow } from 'electron'
import type { ReleaseChannel } from '../../../shared/updater/release-channel'
import type { TeamUpdatePolicy } from '../releases/updater-release-policy'
import type { TeamRestartOptions } from './updater-required-restart'
import type { PreQuitCleanupFailureMode, UpdateInstallMode } from './updater-state'

export type UpdaterSetupOptions = {
  getMainWindow?: () => BrowserWindow | null
  getLastUpdateCheckAt?: () => number | null
  onBeforeQuit?: () => void | Promise<void>
  setLastUpdateCheckAt?: (timestamp: number) => void
  getPendingUpdateNudgeId?: () => string | null
  getDismissedUpdateNudgeId?: () => string | null
  setPendingUpdateNudgeId?: (id: string | null) => void
  setDismissedUpdateNudgeId?: (id: string | null) => void
  getReleaseChannelOverride?: () => ReleaseChannel | null
  getTeamUpdatePolicy?: () => TeamUpdatePolicy | undefined
  onTeamUpdatePolicyChanged?: (listener: () => void) => void
  teamRestart?: TeamRestartOptions
  getUpdateDelayDays?: () => number
  getAutomaticUpdates?: () => boolean
  automaticInstallMustWait?: () => boolean
  installMode?: UpdateInstallMode
  onBeforeQuitFailure?: PreQuitCleanupFailureMode
}
