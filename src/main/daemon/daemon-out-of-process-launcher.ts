import { randomUUID } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
import { DaemonClient } from './client'
import {
  DaemonEndpointOwnershipError,
  holdDaemonAdoptionLease,
  reconcileDaemonPidOwnership
} from './daemon-endpoint-adoption'
import {
  DaemonEndpointUnavailableError,
  launchDaemonChild,
  terminateLaunchedDaemonChild
} from './daemon-launched-child'
import { getDaemonEntryPath, probeDaemonSocket as probeSocket } from './daemon-launch-paths'
import { materializeRelocatedDaemonHost } from './daemon-host-relocation'
import { DAEMON_RECOVERY_BUDGET_MS, daemonRecoveryProbeTimeoutMs } from './daemon-recovery-budget'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'
import {
  getDaemonPidPath,
  type DaemonLauncher,
  type DaemonProcessHandle,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'
import { prepareDaemonReplacement } from './daemon-replacement-preflight'

// Why: the adapter decides a runtime resolver replacement, but the launcher completes it — and by
// then the daemon has usually self-retired (dropping its last authenticated client is enough), so
// there is nothing left to kill and the launcher's own confirmed-kill gate would report nothing.
// The adapter hands the reason across so the launch it triggers reports what actually drove it.
let attributedReplaceReason: DaemonReplaceReason | null = null

export function attributeNextDaemonReplacement(reason: DaemonReplaceReason): void {
  attributedReplaceReason = reason
}

function createPreservedDaemonHandle(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  mode?: 'degraded-new-pty-fallback'
): DaemonProcessHandle {
  const handle: DaemonProcessHandle = {
    adopted: true,
    shutdown: async () => {
      await cleanupDaemonForProtocol(runtimeDir, protocolVersion)
    }
  }
  if (mode) {
    handle.mode = mode
  }
  return handle
}

export function createOutOfProcessLauncher(
  runtimeDir: string,
  macosLoginSessionWatch = false
): DaemonLauncher {
  return async (socketPath, tokenPath, suppliedPidPath, suppliedLaunchNonce) => {
    const entryPath = getDaemonEntryPath()
    // Why here: everything up to the fork is one recovery, so the adoption connect and the
    // preflight's probes share a single absolute budget rather than each carrying its own.
    const recoveryDeadlineMs = Date.now() + DAEMON_RECOVERY_BUDGET_MS
    const pidPath = suppliedPidPath ?? getDaemonPidPath(runtimeDir)
    const launchNonce = suppliedLaunchNonce ?? randomUUID()
    // One-shot: whichever launch consumes it owns the attribution, so a later unrelated launch can't
    // reuse it. The write in the respawn closure reaches here without an intervening await, which is
    // what makes a bare module-scoped slot safe — keep it that way or a concurrent launch can steal it.
    const attributedReason = attributedReplaceReason
    attributedReplaceReason = null
    let adoptionClient: DaemonClient | null = new DaemonClient({
      socketPath,
      tokenPath
    })
    try {
      // Why: acquire the full pair before control-only probes so an expired inherited deadline can't fire in the probe-to-adoption gap.
      // Why bounded: unbudgeted this grants a fresh 5s to each of four connect/hello steps, so a
      // wedged endpoint burns more before recovery starts than recovery itself is allowed.
      await adoptionClient.ensureConnectedWithin(daemonRecoveryProbeTimeoutMs(recoveryDeadlineMs))
      await reconcileDaemonPidOwnership(adoptionClient, pidPath)
    } catch {
      adoptionClient.disconnect()
      adoptionClient = null
    }
    const releaseAdoptionClient = (): void => {
      adoptionClient?.disconnect()
      adoptionClient = null
    }
    const preserveDaemon = async (
      mode?: 'degraded-new-pty-fallback'
    ): Promise<DaemonProcessHandle> => {
      const connectedClient = adoptionClient ?? undefined
      adoptionClient = null
      return holdDaemonAdoptionLease(
        createPreservedDaemonHandle(runtimeDir, PROTOCOL_VERSION, mode),
        socketPath,
        tokenPath,
        connectedClient,
        undefined,
        pidPath
      )
    }
    try {
      const preservedHandle = await prepareDaemonReplacement({
        runtimeDir,
        socketPath,
        tokenPath,
        entryPath,
        recoveryDeadlineMs,
        attributedReason,
        releaseAdoptionClient,
        preserveDaemon
      })
      if (preservedHandle) {
        return preservedHandle
      }

      const userDataPath = getAppEnvironment().getPath('userData')
      // Why: on win32 packaged, stage a daemon-host copy in userData so its image escapes the NSIS updater's kill zone; lazy so it's off first-paint. Fail-open: null → in-dir host.
      const relocatedHost = materializeRelocatedDaemonHost()
      // Fork the relocated entry when available; otherwise the install-dir entry.
      const forkEntryPath = relocatedHost ? relocatedHost.entryPath : entryPath
      let launched
      try {
        launched = await launchDaemonChild({
          entryPath,
          forkEntryPath,
          relocatedExecPath: relocatedHost?.execPath,
          userDataPath,
          socketPath,
          tokenPath,
          pidPath,
          launchNonce,
          macosLoginSessionWatch
        })
      } catch (error) {
        if (!(error instanceof DaemonEndpointUnavailableError) || error.reason !== 'occupied') {
          throw error
        }
        // Why adopt rather than retry: another daemon proved it owns the endpoint and is
        // answering on it. Forking again would lose the same race, and reporting a startup
        // failure strands this app on local non-persistent PTYs beside a healthy daemon.
        console.warn(
          '[daemon] Endpoint was taken by another daemon during startup — adopting it instead'
        )
        // Why pidPath: adopting reconciles the PID record against the identity the daemon
        // reports over hello, repairing a record that names the wrong incarnation. Every other
        // adoption path passes it; this one skipped it, so the incumbent we adopt here was the
        // only one whose record never got that repair.
        return await holdDaemonAdoptionLease(
          createPreservedDaemonHandle(runtimeDir),
          socketPath,
          tokenPath,
          undefined,
          undefined,
          pidPath
        )
      }

      try {
        return await holdDaemonAdoptionLease(
          {
            shutdown: () => terminateLaunchedDaemonChild(launched.child)
          },
          socketPath,
          tokenPath,
          undefined,
          launched.identity,
          pidPath
        )
      } catch (error) {
        if (error instanceof DaemonEndpointOwnershipError) {
          await terminateLaunchedDaemonChild(launched.child)
          unlinkOwnedDaemonPidFile(pidPath, launched.child.pid as number, launchNonce)
          throw error
        }
        // Why: another client may have adopted this live process; keep its pid record until exit, but remove one published after an early exit.
        let pidRecordRemoved = false
        const removeExitedPidRecord = (): void => {
          if (pidRecordRemoved) {
            return
          }
          pidRecordRemoved = true
          unlinkOwnedDaemonPidFile(pidPath, launched.child.pid as number, launchNonce)
        }
        launched.child.once('exit', removeExitedPidRecord)
        if (
          (launched.child.exitCode !== null && launched.child.exitCode !== undefined) ||
          (launched.child.signalCode !== null && launched.child.signalCode !== undefined)
        ) {
          launched.child.off('exit', removeExitedPidRecord)
          removeExitedPidRecord()
        }
        throw error
      }
    } catch (error) {
      releaseAdoptionClient()
      // Why: the launcher may now fork onto an endpoint it could not classify, because the
      // publisher is the real guard — and that guard works by refusing to overwrite what it
      // cannot prove dead, so the child exits instead of splitting the brain. Correct, but
      // giving up here costs the user every persistent session for the whole run. Something
      // answering the endpoint now is a daemon worth adopting, not a reason to fall back to
      // local PTYs.
      // Why unbudgeted: the recovery deadline bounds the adopt-or-replace decision, and this runs
      // after it — past the kill, the fork and the lease. Clamping to the remainder yields a 1ms
      // probe that loses to its own timer against a live socket, turning the rescue into the total
      // daemon loss it exists to prevent.
      if (await probeSocket(socketPath)) {
        console.warn(
          '[daemon] DEGRADED MODE: adopting the daemon that owns the endpoint after a replacement could not publish onto it. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          // It stopped answering between the probe and the adoption; report the launch failure.
        }
      }
      throw error
    }
  }
}
