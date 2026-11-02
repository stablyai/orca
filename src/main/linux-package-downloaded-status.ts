import type { UpdateStatus } from '../shared/update-status-types'
import {
  captureLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact,
  getTrackedLinuxPackageArtifact
} from './linux-package-update-recovery'
import { getLinuxPackageType } from './linux-update-package-type'
import type { LinuxPackageArtifact } from './linux-package-update-recovery'
import { updaterCodedMessage } from '../shared/updater-failure-copy'

export function createLinuxPackageManualInstallStatus(
  artifact: Pick<LinuxPackageArtifact, 'packageType' | 'version'>
): UpdateStatus {
  return {
    state: 'error',
    ...updaterCodedMessage('linuxPackageManualInstall'),
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
      ...updaterCodedMessage('linuxPackageMarkerUnusable'),
      version: info.version,
      retryable: false
    }
  }
  const artifact = captureLinuxPackageArtifact(info)
  if (!artifact) {
    return {
      state: 'error',
      ...updaterCodedMessage('linuxPackageMetadataUnusable'),
      version: info.version,
      retryable: false
    }
  }
  return createLinuxPackageManualInstallStatus(artifact)
}
