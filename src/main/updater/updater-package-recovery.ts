import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  getTrackedLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact,
  revalidateLinuxPackageForInstall,
  resolveLinuxPackageInstallInstructions,
  revealLinuxPackage,
  type LinuxPackageArtifact,
  type LinuxPackageRecoveryUnavailableReason
} from '../linux-package-update-recovery'
import {
  getLinuxPackageInstallDiagnostic,
  parseLinuxPackageInstallExitCode,
  redactLinuxPackageInstallText
} from '../linux-package-install-diagnostic'
import type {
  LinuxPackageInstallInstructions,
  LinuxPackageInstallRecovery,
  UpdateStatus
} from '../../shared/update-status-types'
import { UpdaterInstallSupport } from './updater-install-support'

const LINUX_PACKAGE_RECOVERY_MESSAGES: Record<LinuxPackageRecoveryUnavailableReason, string> = {
  missing:
    'The downloaded package is no longer in the update cache. Download the update again, or get it from the official release page.',
  // Why: this reason also covers a path that left the cache (traversal or symlinked parent), so the copy must not promise the file merely changed type.
  'not-regular':
    'The downloaded package is no longer a valid file in the update cache. Download the update again, or get it from the official release page.',
  'hash-mismatch':
    'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.',
  'read-failed':
    'Orca could not read the downloaded package. Download the update again, or get it from the official release page.',
  'no-sudo':
    'No sudo command was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  'no-package-manager':
    'No supported package manager was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  // Defensive: capture only ever tracks absolute cache paths, so this reports a bug rather than a machine state.
  'invalid-package-path':
    'The downloaded package is not at a usable path, so Orca cannot build a safe install command. Show the package and install it with your package manager.'
}

// Why: clearing the artifact alone would leave the renderer's actions enabled; the status must lose its recovery too.
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

  protected failLinuxPackageRecovery(
    recovery: LinuxPackageInstallRecovery,
    reason: LinuxPackageRecoveryUnavailableReason
  ): never {
    this.recordLinuxPackageRecoveryUnavailable(recovery, reason)
    const message = LINUX_PACKAGE_RECOVERY_MESSAGES[reason]
    // Why: hashing 160 MB takes long enough for a new cycle to land. Acting on a stale verdict would
    // destroy the newer artifact and clobber whatever card replaced this one.
    const active = this.getActiveLinuxPackageRecovery()
    const stillCurrent =
      active?.version === recovery.version && active?.packageType === recovery.packageType
    if (stillCurrent && RECOVERY_CLEARING_REASONS.includes(reason)) {
      clearTrackedLinuxPackageArtifact()
      this.sendStatus({ state: 'error', message })
    }
    throw new Error(message)
  }

  /**
   * Identifies the update cycle an install belongs to, so a verdict produced by a multi-second hash
   * can be dropped when a newer cycle already replaced the card it would otherwise overwrite.
   */
  protected getInstallCycleSignature(): string {
    const recovery = this.getActiveLinuxPackageRecovery()
    if (recovery) {
      return `recovery:${recovery.packageType}:${recovery.version}`
    }
    return this.currentStatus.state === 'downloaded'
      ? `downloaded:${this.currentStatus.version}`
      : `state:${this.currentStatus.state}`
  }

  /**
   * Re-proves the retained package before the install starts. Returns false when the install must be
   * abandoned; the artifact is only re-read here, so callers still own every teardown decision.
   */
  protected async proveRetainedLinuxPackage(pendingVersion: string): Promise<boolean> {
    const artifact = getTrackedLinuxPackageArtifact()
    if (!artifact) {
      return true
    }
    // Why: an artifact retained from another cycle says nothing about the file electron-updater is
    // about to install, so proving it would block a legitimate install on an unrelated digest.
    if (pendingVersion && pendingVersion !== artifact.version) {
      return true
    }
    const recovery = this.getActiveLinuxPackageRecovery()
    const cycle = this.getInstallCycleSignature()
    const reason = await this.revalidateRetainedLinuxPackage(artifact)
    if (!reason) {
      return true
    }
    this.reportLinuxPackageRevalidationFailure({ artifact, recovery, reason, cycle })
    return false
  }

  /** The failing reason, or null when the retained package still matches its release digest. */
  protected async revalidateRetainedLinuxPackage(
    artifact: LinuxPackageArtifact
  ): Promise<LinuxPackageRecoveryUnavailableReason | null> {
    this.linuxPackageRevalidationInFlight = true
    try {
      const verdict = await revalidateLinuxPackageForInstall(artifact)
      return verdict.ok ? null : verdict.reason
    } catch (error) {
      recordUpdaterLifecycle(
        'linux_package_revalidation_errored',
        { errorType: error instanceof Error ? error.name : typeof error },
        { level: 'warn', message: 'Could not re-verify the retained update package' }
      )
      // Why: fail closed — bytes we could not read are bytes we cannot hand to a root installer.
      return 'read-failed'
    } finally {
      // Why: the invariant every install path depends on — a wedged flag would make quitAndInstall
      // early-return for the rest of the session.
      this.linuxPackageRevalidationInFlight = false
    }
  }

  protected reportLinuxPackageRevalidationFailure({
    artifact,
    recovery,
    reason,
    cycle
  }: {
    artifact: LinuxPackageArtifact
    recovery: LinuxPackageInstallRecovery | null
    reason: LinuxPackageRecoveryUnavailableReason
    cycle: string
  }): void {
    recordUpdaterLifecycle(
      'linux_package_revalidation_failed',
      {
        action: recovery ? 'retry-automatic' : 'restart-to-install',
        packageType: artifact.packageType,
        version: artifact.version,
        reason
      },
      { level: 'warn', message: 'Retained update package failed its pre-install digest check' }
    )
    // Why: a package proven bad must not stay tracked, but a download that landed during the hash
    // owns the slot now and destroying it would force a needless 160 MB redownload.
    const clearsArtifact = RECOVERY_CLEARING_REASONS.includes(reason)
    if (clearsArtifact && getTrackedLinuxPackageArtifact() === artifact) {
      clearTrackedLinuxPackageArtifact()
    }
    // Why: same reasoning as failLinuxPackageRecovery — a verdict from a cycle that has since been
    // replaced must not clobber whatever card the user is looking at now.
    if (this.getInstallCycleSignature() !== cycle) {
      return
    }
    this.sendInstallFailureStatus({
      state: 'error',
      message: LINUX_PACKAGE_RECOVERY_MESSAGES[reason],
      // Why: an unreadable file is not evidence the bytes changed, so the recovery card and its
      // Copy/Show actions survive a transient I/O failure exactly as they do elsewhere.
      ...(recovery && !clearsArtifact ? { recovery } : {})
    })
  }

  protected async getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
    const recovery = this.getActiveLinuxPackageRecovery()
    if (!recovery) {
      throw new Error('No package install recovery is available.')
    }
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'copy-command',
      packageType: recovery.packageType,
      version: recovery.version
    })
    const result = await resolveLinuxPackageInstallInstructions(recovery)
    if (!result.ok) {
      // Why: the renderer must distinguish "this machine has no package manager" (keep the card, promote
      // Show Package) from "the artifact is gone" (recovery is cleared and the card unmounts).
      if (result.reason === 'no-sudo' || result.reason === 'no-package-manager') {
        this.recordLinuxPackageRecoveryUnavailable(recovery, result.reason)
        return {
          ok: false,
          reason: result.reason,
          message: LINUX_PACKAGE_RECOVERY_MESSAGES[result.reason]
        }
      }
      this.failLinuxPackageRecovery(recovery, result.reason)
    }
    return { ok: true, command: result.command, packageFileName: result.packageFileName }
  }

  protected async showLinuxPackage(): Promise<void> {
    const recovery = this.getActiveLinuxPackageRecovery()
    if (!recovery) {
      throw new Error('No package install recovery is available.')
    }
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'show-package',
      packageType: recovery.packageType,
      version: recovery.version
    })
    const result = await revealLinuxPackage(recovery)
    if (!result.ok) {
      this.failLinuxPackageRecovery(recovery, result.reason)
    }
  }

  /** Builds a recoverable status when the native Linux package installer rejects a retained artifact. */
  protected buildLinuxPackageInstallFailureStatus(error: unknown): UpdateStatus | null {
    const artifact = getTrackedLinuxPackageArtifact()
    if (!artifact) {
      return null
    }
    const pendingVersion = this.getPendingInstallVersion()
    if (pendingVersion && pendingVersion !== artifact.version) {
      return null
    }
    const diagnostic = getLinuxPackageInstallDiagnostic() ?? this.lastInstallAttemptDiagnostic
    const reason = diagnostic?.reason ?? 'package-install-failed'
    const exitCode = parseLinuxPackageInstallExitCode(error)
    recordUpdaterLifecycle(
      'linux_package_install_failed',
      {
        packageType: artifact.packageType,
        reason,
        ...(exitCode === null ? {} : { exitCode }),
        version: artifact.version,
        errorType: error instanceof Error ? error.name : typeof error
      },
      { level: 'warn', message: 'Linux package install failed; cached package retained' }
    )
    const message =
      diagnostic?.message ??
      (error instanceof Error
        ? redactLinuxPackageInstallText(error.message, artifact.path)
        : null) ??
      'The system package installer did not start.'
    return {
      state: 'error',
      message,
      recovery: {
        kind: 'linux-package-install',
        packageType: artifact.packageType,
        reason,
        version: artifact.version
      }
    }
  }
}
