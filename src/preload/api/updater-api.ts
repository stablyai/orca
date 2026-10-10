import type {
  LinuxPackageInstallInstructions,
  ReleaseBuildListResult,
  UpdateCheckOptions,
  UpdateStatus
} from '../../shared/update-status-types'
import type { ReleaseChannel } from '../../shared/release-channel'

export type UpdaterApi = {
  getVersion: () => Promise<string>
  getStatus: () => Promise<UpdateStatus>
  check: (options?: UpdateCheckOptions) => Promise<void>
  download: () => Promise<void>
  quitAndInstall: () => Promise<void>
  dismissNudge: () => Promise<void>
  dismissAvailableUpdate: () => Promise<void>
  /** Desktop-only. Rejects unless the current status carries `linux-package-install` recovery. */
  getLinuxPackageInstallInstructions: () => Promise<LinuxPackageInstallInstructions>
  /** Desktop-only. Reveals the revalidated cached package in the native file manager. */
  showLinuxPackage: () => Promise<void>
  /** `force` bypasses the main-process list cache — the refresh button, not mount or channel switches. */
  listBuilds: (
    channel: ReleaseChannel,
    options?: { force?: boolean }
  ) => Promise<ReleaseBuildListResult>

  onStatus: (callback: (status: UpdateStatus) => void) => () => void
  onClearDismissal: (callback: () => void) => () => void
}
