import { app } from 'electron'
import { killAllPty } from '../ipc/pty'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  clearUpdateRequest,
  clearUpdateResult,
  getServeUpdateAttemptId,
  getServeUpdateUnitName,
  readServeUpdateResultFor,
  writeServeUpdateCensusContinuation,
  writeUpdateRequest
} from '../serve-update-spool'
import type { ServeUpdateVerdict } from '../../shared/serve-update-spool'
import { captureServeUpdateAppImage } from '../serve-update-artifact-capture'
import { resolveTrustedExecutable } from '../linux-package-install-command'
import { SERVE_UPDATE_HELPER_INSTALL_PATH } from '../cli/serve-update-helper-installer'
import { runProcess } from '../../shared/child-process/run-process'
import { runServeUpdateCensus, type CensusCapableRuntime } from '../serve-update-census'
import { UpdaterPackageRecovery } from './updater-package-recovery'

const SERVE_UPDATE_VERDICT_TIMEOUT_MS = 90_000
const SERVE_UPDATE_VERDICT_POLL_MS = 500
const SERVE_UPDATE_HELPER_SPAWN_TIMEOUT_MS = 15_000

/**
 * Linux supervised-headless-serve install: spool the request, hand it to the root
 * helper, and quit only after the helper accepts. Split from
 * updater-install-execution.ts to keep both files under the max-lines limit.
 */
export abstract class UpdaterServeInstallHandoff extends UpdaterPackageRecovery {
  /** Set by serve startup; identifies the runtime across the restart the helper performs. */
  private serveUpdateRuntimeId = ''
  /** The most recent update-downloaded event, kept for the supervised serve install path. */
  private supervisedServeDownloadInfo: Record<string, unknown> | null = null
  /** Set by serve startup; the census fence re-consults it immediately before quit. */
  private serveUpdateCensusRuntime: CensusCapableRuntime | null = null

  /** Called by serve startup once the runtime id exists. */
  setServeUpdateRuntimeId(runtimeId: string): void {
    this.serveUpdateRuntimeId = runtimeId
  }

  /** Called by serve startup alongside the runtime id; null keeps the fence unarmed. */
  setServeUpdateCensusRuntime(runtime: CensusCapableRuntime | null): void {
    this.serveUpdateCensusRuntime = runtime
  }

  /** Called by the update-downloaded event bridge so serve can spool the artifact later. */
  recordSupervisedServeDownloadInfo(info: unknown): void {
    if (this.updateInstallMode !== 'supervised-headless-serve') {
      return
    }
    this.supervisedServeDownloadInfo =
      info && typeof info === 'object' ? (info as Record<string, unknown>) : null
  }

  private consumeSupervisedServeDownloadInfo(): Record<string, unknown> | null {
    const info = this.supervisedServeDownloadInfo
    this.supervisedServeDownloadInfo = null
    return info
  }

  /**
   * Captures the downloaded AppImage and spools the install request for the root helper.
   * Clears BOTH spool files first so a stale verdict from a previous attempt can never be
   * mistaken for this one's. Returns the spooled target version, or null after reporting
   * the failure.
   */
  private async captureAndSpoolUpdate(pendingVersion: string): Promise<string | null> {
    clearUpdateResult()
    clearUpdateRequest()
    const downloadInfo = this.consumeSupervisedServeDownloadInfo()
    if (!downloadInfo) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: 'missing-download-metadata' },
        { level: 'warn', message: 'No verifiable AppImage download for the supervised install' }
      )
      this.sendErrorStatus('Could not verify the downloaded update. Orca remains running.', true)
      return null
    }
    const capture = await captureServeUpdateAppImage(downloadInfo)
    if (!capture.ok) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: `artifact-${capture.reason}` },
        { level: 'warn', message: 'The downloaded AppImage failed verification' }
      )
      this.sendErrorStatus('The downloaded update failed verification. Orca remains running.', true)
      return null
    }
    if (
      !writeUpdateRequest({
        runtimeId: this.serveUpdateRuntimeId,
        fromVersion: app.getVersion(),
        targetVersion: capture.artifact.targetVersion,
        artifactPath: capture.artifact.artifactPath,
        sha512: capture.artifact.sha512,
        servingPid: process.pid,
        unitName: getServeUpdateUnitName()
      })
    ) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: 'spool-write-failed' },
        { level: 'warn', message: 'Could not write the serve update request' }
      )
      this.sendErrorStatus(
        'Could not hand the update to the server supervisor. Orca remains running.',
        true
      )
      return null
    }
    return capture.artifact.targetVersion
  }

  /** Resolves once the helper's verdict lands in the spool, or null on timeout. Never clears spool state. */
  private async awaitSupervisedServeVerdict(
    attemptId: string,
    targetVersion: string,
    isAborted: () => boolean = () => false
  ): Promise<{ verdict: ServeUpdateVerdict; message: string } | null> {
    const deadline = Date.now() + SERVE_UPDATE_VERDICT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const result = readServeUpdateResultFor(attemptId, targetVersion)
      if (result) {
        return result
      }
      if (isAborted()) {
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, SERVE_UPDATE_VERDICT_POLL_MS))
    }
    return null
  }

  /**
   * Launches the root helper non-interactively. Races the helper's exit against the
   * verdict poll so a fast sudo failure (no cached credentials, helper missing) errors
   * out early instead of stalling the full 90s window.
   */
  private async spawnSupervisedServeHelper(): Promise<void> {
    const sudoPath = resolveTrustedExecutable('sudo')
    if (!sudoPath) {
      throw new Error('sudo_not_found')
    }
    const result = await runProcess({
      program: sudoPath,
      args: ['-n', SERVE_UPDATE_HELPER_INSTALL_PATH],
      timeoutMs: SERVE_UPDATE_VERDICT_TIMEOUT_MS + SERVE_UPDATE_HELPER_SPAWN_TIMEOUT_MS
    })
    if (result.code !== 0) {
      throw new Error(
        `helper-exit-${result.code}${result.timedOut ? '-timeout' : ''}: ${result.stderr || result.stdout}`
      )
    }
  }

  protected async performSupervisedServeInstall(pendingVersion: string): Promise<void> {
    this.quitAndInstallInProgress = true
    this.quittingForUpdate = true
    const targetVersion = await this.captureAndSpoolUpdate(pendingVersion)
    if (!targetVersion) {
      this.resetQuitForUpdateState()
      return
    }
    // Why: the helper must be running for the verdict to ever appear, but a helper
    // that dies fast (no sudo, bad install) should surface quickly instead of
    // burning the full 90s window. Race spawn-exit against the verdict poll: a
    // spawn error aborts the poll immediately.
    let spawnError: string | null = null
    const helperRun = this.spawnSupervisedServeHelper().catch((error: unknown) => {
      spawnError = error instanceof Error ? error.message : String(error)
    })
    const attemptId = getServeUpdateAttemptId()
    const outcome = attemptId
      ? await this.awaitSupervisedServeVerdict(attemptId, targetVersion, () => spawnError !== null)
      : null
    if (spawnError && !outcome) {
      await helperRun
      clearUpdateRequest()
      recordUpdaterLifecycle(
        'headless_serve_update_not_accepted',
        { version: pendingVersion || null, reason: spawnError },
        { level: 'warn', message: 'The server update helper could not run' }
      )
      this.sendErrorStatus('Could not launch the server update helper. Orca remains running.', true)
      this.resetQuitForUpdateState()
      return
    }
    if (!outcome || outcome.verdict !== 'accepted') {
      // Why: a rejected/failed/timed-out request must not linger for the next boot's helper.
      clearUpdateRequest()
      recordUpdaterLifecycle(
        'headless_serve_update_not_accepted',
        { version: pendingVersion || null },
        { level: 'warn', message: 'The server supervisor did not accept the update' }
      )
      this.sendErrorStatus(
        outcome?.message || 'The server update did not complete. The server keeps running.',
        true
      )
      this.resetQuitForUpdateState()
      return
    }
    recordUpdaterLifecycle('headless_serve_update_accepted', { version: pendingVersion || null })
    // Census-and-stop fence: the install-RPC gate ran earlier, so work may have started
    // since. Re-run the census here, as close to the quit as this process can get; the
    // helper's systemctl stop is the other half of the fence. A blocked census aborts
    // the install and the server keeps running.
    if (this.serveUpdateCensusRuntime) {
      const census = await runServeUpdateCensus(this.serveUpdateCensusRuntime)
      if (!census.ok) {
        clearUpdateRequest()
        recordUpdaterLifecycle(
          'headless_serve_update_census_blocked',
          { version: pendingVersion || null, reason: census.reason },
          {
            level: 'warn',
            message: 'Server update blocked at the quit fence: live terminals may exist'
          }
        )
        this.sendErrorStatus(
          'The server still has live terminals or agents. Close them, then try the update again.',
          true
        )
        this.resetQuitForUpdateState()
        return
      }
    }
    // Why before quit: the helper needs the unit stop to look like a supervised exit, and
    // pre-quit cleanup (auth preservation) must still run while this process is alive.
    // The continuation tells the helper the quit-fence census passed so it may stop the
    // unit; on a blocked census the request was cleared instead, which cancels the helper.
    writeServeUpdateCensusContinuation()
    await this.runBeforeUpdateQuitCleanup()
    killAllPty()
    // Why: the helper stops the unit; systemd's RestartPreventExitStatus=3 plus a clean quit
    // keep this exit from being read as a crash. Fail-safe remains the exit watchdog.
    armUpdateInstallExitWatchdog()
    app.quit()
  }
}
