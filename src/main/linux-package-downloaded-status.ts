import type { UpdateStatus } from '../shared/update-status-types'
import {
  captureLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact,
  getTrackedLinuxPackageArtifact
} from './linux-package-update-recovery'
import { getLinuxPackageType } from './linux-update-package-type'
import type { LinuxPackageArtifact } from './linux-package-update-recovery'

export const LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE =
  'Orca could not verify the installed Linux package format, so it will not install this update automatically. Download the update from the official release page and install it manually.'
export const LINUX_PACKAGE_EXTERNALLY_MANAGED_MESSAGE =
  'This copy of Orca is managed by your system package manager, so Orca cannot install updates itself. Update Orca through your distribution instead.'
export const LINUX_PACKAGE_MANUAL_INSTALL_MESSAGE =
  'Quit Orca before running the system package install command.'
const PACKAGE_METADATA_UNUSABLE_MESSAGE =
  'The downloaded package metadata could not be verified. Quit Orca before downloading and installing the update from the official release page.'

export function createLinuxPackageManualInstallStatus(
  artifact: Pick<LinuxPackageArtifact, 'packageType' | 'version'>
): UpdateStatus {
  return {
    state: 'error',
    message: LINUX_PACKAGE_MANUAL_INSTALL_MESSAGE,
    recovery: {
      kind: 'linux-package-install',
      packageType: artifact.packageType,
      reason: 'manual-install-required',
      version: artifact.version
    }
  }
}

export function getRetainedLinuxPackageManualInstallStatus(): UpdateStatus | null {
  const artifact = getTrackedLinuxPackageArtifact()
  return artifact ? createLinuxPackageManualInstallStatus(artifact) : null
}

function getActiveDownloadVersion(status: UpdateStatus): string | null {
  if (status.state === 'downloading' || status.state === 'downloaded') {
    return status.version
  }
  if (status.state === 'error' && status.recovery?.kind === 'linux-package-install') {
    return status.recovery.version
  }
  return null
}

export function shouldIgnoreDownloadedUpdateEvent(
  status: UpdateStatus,
  infoVersion: string,
  pendingVersion: string
): boolean {
  const activeDownloadVersion = getActiveDownloadVersion(status)
  return (
    activeDownloadVersion === null ||
    infoVersion !== activeDownloadVersion ||
    (pendingVersion !== '' && infoVersion !== pendingVersion)
  )
}

export function resolveLinuxPackageDownloadedStatus(info: {
  version: string
}): UpdateStatus | null {
  const packageType = getLinuxPackageType()
  if (packageType === 'non-root') {
    return null
  }
  if (packageType === 'unusable') {
    clearTrackedLinuxPackageArtifact()
    return {
      state: 'error',
      message: LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE,
      version: info.version,
      retryable: false
    }
  }
  const artifact = captureLinuxPackageArtifact(info)
  if (!artifact) {
    return {
      state: 'error',
      message: PACKAGE_METADATA_UNUSABLE_MESSAGE,
      version: info.version,
      retryable: false
    }
  }
  return createLinuxPackageManualInstallStatus(artifact)
}
