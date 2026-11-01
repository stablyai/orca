import { shell } from 'electron'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  getTrackedLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact,
  resolveLinuxPackageInstallInstructions,
  resolveLinuxPackageRevealTarget,
  type LinuxPackageArtifact,
  type LinuxPackageRecoveryUnavailableReason
} from '../linux-package-update-recovery'
import type {
  LinuxPackageInstallInstructions,
  LinuxPackageInstallRecovery
} from '../../shared/update-status-types'
import { UpdaterInstallSupport } from './updater-install-support'
import {
  updaterCodedMessage,
  updaterFailureText,
  type UpdaterFailureCode
} from '../../shared/updater-failure-copy'

const LINUX_PACKAGE_RECOVERY_CODES: Record<
  LinuxPackageRecoveryUnavailableReason,
  UpdaterFailureCode
> = {
  missing: 'linuxPackageMissing',
  // Also covers traversal/symlink escape from cache; do not claim only file type changed.
  'not-regular': 'linuxPackageNotRegular',
  'hash-mismatch': 'linuxPackageHashMismatch',
  'read-failed': 'linuxPackageReadFailed',
  'no-sudo': 'linuxPackageNoSudo',
  'no-package-manager': 'linuxPackageNoPackageManager',
  // Capture tracks absolute cache paths; invalid paths indicate a bug.
  'invalid-package-path': 'linuxPackageInvalidPath'
}

// Clear status recovery with the artifact or renderer actions stay enabled.
const RECOVERY_CLEARING_REASONS: LinuxPackageRecoveryUnavailableReason[] = [
  'missing',
  'not-regular',
  'hash-mismatch'
]

export abstract class UpdaterPackageRecovery extends UpdaterInstallSupport {
  protected getActiveLinuxPackageRecovery(): LinuxPackageInstallRecovery | null {
    if (this.currentStatus.state !== 'error') {
      return null
    }
    return this.currentStatus.recovery?.kind === 'linux-package-install'
      ? this.currentStatus.recovery
      : null
  }

  protected recordLinuxPackageRecoveryUnavailable(
    recovery: LinuxPackageInstallRecovery,
    reason: LinuxPackageRecoveryUnavailableReason
  ): void {
    recordUpdaterLifecycle(
      'linux_package_recovery_unavailable',
      { reason, packageType: recovery.packageType, version: recovery.version },
      { level: 'warn', message: 'Linux package recovery action unavailable' }
    )
  }

  /** Whether the card this action was invoked from still owns both the status and the artifact. */
  protected isCurrentLinuxPackageRecovery(
    recovery: LinuxPackageInstallRecovery,
    artifact: LinuxPackageArtifact | null
  ): boolean {
    return (
      this.getActiveLinuxPackageRecovery() === recovery &&
      getTrackedLinuxPackageArtifact() === artifact
    )
  }

  protected assertCurrentLinuxPackageRecovery(
    recovery: LinuxPackageInstallRecovery,
    artifact: LinuxPackageArtifact | null
  ): void {
    if (!this.isCurrentLinuxPackageRecovery(recovery, artifact)) {
      throw new Error('Package install recovery is no longer current.')
    }
  }

  protected failLinuxPackageRecovery(
    recovery: LinuxPackageInstallRecovery,
    artifact: LinuxPackageArtifact | null,
    reason: LinuxPackageRecoveryUnavailableReason
  ): never {
    this.assertCurrentLinuxPackageRecovery(recovery, artifact)
    this.recordLinuxPackageRecoveryUnavailable(recovery, reason)
    const coded = updaterCodedMessage(LINUX_PACKAGE_RECOVERY_CODES[reason])
    if (RECOVERY_CLEARING_REASONS.includes(reason)) {
      clearTrackedLinuxPackageArtifact()
      this.sendStatus({ state: 'error', ...coded, version: recovery.version })
    }
    throw new Error(coded.message)
  }

  protected async getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
    const recovery = this.getActiveLinuxPackageRecovery()
    if (!recovery) {
      throw new Error('No package install recovery is available.')
    }
    const artifact = getTrackedLinuxPackageArtifact()
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'copy-command',
      packageType: recovery.packageType,
      version: recovery.version
    })
    const result = await resolveLinuxPackageInstallInstructions(recovery)
    if (!result.ok) {
      // Missing tools keep the card with Show Package; missing artifacts clear recovery and unmount it.
      if (result.reason === 'no-sudo' || result.reason === 'no-package-manager') {
        this.assertCurrentLinuxPackageRecovery(recovery, artifact)
        this.recordLinuxPackageRecoveryUnavailable(recovery, result.reason)
        return {
          ok: false,
          reason: result.reason,
          message: updaterFailureText(LINUX_PACKAGE_RECOVERY_CODES[result.reason])
        }
      }
      this.failLinuxPackageRecovery(recovery, artifact, result.reason)
    }
    this.assertCurrentLinuxPackageRecovery(recovery, artifact)
    return { ok: true, command: result.command, packageFileName: result.packageFileName }
  }

  protected async showLinuxPackage(): Promise<void> {
    const recovery = this.getActiveLinuxPackageRecovery()
    if (!recovery) {
      throw new Error('No package install recovery is available.')
    }
    const artifact = getTrackedLinuxPackageArtifact()
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'show-package',
      packageType: recovery.packageType,
      version: recovery.version
    })
    const result = await resolveLinuxPackageRevealTarget(recovery)
    if (!result.ok) {
      this.failLinuxPackageRecovery(recovery, artifact, result.reason)
    }
    this.assertCurrentLinuxPackageRecovery(recovery, artifact)
    // The installed app host owns this path, independent of workspace SSH/WSL hosts.
    try {
      shell.showItemInFolder(result.path)
    } catch {
      this.failLinuxPackageRecovery(recovery, artifact, 'read-failed')
    }
  }
}
