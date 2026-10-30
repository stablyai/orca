import { randomUUID } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
import { DaemonClient } from './client'
import {
  DaemonEndpointOwnershipError,
  holdDaemonAdoptionLease,
  reconcileDaemonPidOwnership
} from './daemon-endpoint-adoption'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../startup/first-window-startup-services'
import {
  DAEMON_CHILD_STARTUP_TIMEOUT_MS,
  DaemonEndpointUnavailableError,
  launchDaemonChild,
  terminateLaunchedDaemonChild
} from './daemon-launched-child'
import { getDaemonEntryPath, probeDaemonSocket as probeSocket } from './daemon-launch-paths'
import { materializeRelocatedDaemonHost, pruneDaemonHostStaging } from './daemon-host-relocation'
import { appImageDaemonIdentityPath, resolveAppImageDaemonLaunch } from './daemon-appimage-launch'
import { resolveAppImageGenerationDaemonLaunch } from './daemon-appimage-generation-launch'
import { waitForAppImageCopyPreExtraction } from '../cli/appimage-copy-pre-extraction'
import { launchMacDaemonFromStableBundle } from './macos-daemon-launchd'
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
import { ensureDaemonSocketDir } from './daemon-socket-endpoint-path'
import { inspectDaemonHostImage } from './daemon-host-image'
import { noteSeveredDaemon } from './daemon-host-image-state'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'

// Carry the adapter's cause into launch reporting even if the outgoing daemon self-retires first.
let attributedReplaceReason: DaemonReplaceReason | null = null

// The fork fallback's readiness wait plus the lease and adapter connects must still fit the gate.
const MAC_STABLE_LAUNCH_HANDOFF_MS =
  LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS - DAEMON_CHILD_STARTUP_TIMEOUT_MS - 5_000

export function attributeNextDaemonReplacement(reason: DaemonReplaceReason): void {
  attributedReplaceReason = reason
}

// Check every adoption: severed AppImage daemons can answer RPCs but must not receive new terminals.
function createPreservedDaemonHandle(
  runtimeDir: string,
  pidPath: string,
  mode?: 'degraded-new-pty-fallback'
): DaemonProcessHandle {
  const handle: DaemonProcessHandle = {
    adopted: true,
    shutdown: async () => {
      await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
    }
  }
  const hostImage = inspectDaemonHostImage(readDaemonPidRecord(pidPath))
  if (hostImage.verdict === 'severed') {
    console.warn(
      `[daemon] DEGRADED MODE: keeping daemon PID ${hostImage.pid} whose AppImage files are gone. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the terminal daemon.`
    )
    noteSeveredDaemon(hostImage)
    handle.mode = 'degraded-new-pty-fallback'
    handle.quarantine = 'host-image-severed'
    return handle
  }
  if (mode) {
    handle.mode = mode
  }
  return handle
}

export type DaemonLaunchPolicy = {
  macosLoginSessionWatch?: boolean
  startupTimeoutMs?: number
  spawnAdmission?: 'observe' | 'enforce'
  /** Replace a stale-version daemon once it drains on every platform, not only macOS. */
  recycleStaleDaemonOnEveryPlatform?: boolean
}

export function createOutOfProcessLauncher(
  runtimeDir: string,
  { macosLoginSessionWatch = false, startupTimeoutMs, spawnAdmission }: DaemonLaunchPolicy = {}
): DaemonLauncher {
  return async (socketPath, tokenPath, suppliedPidPath, suppliedLaunchNonce) => {
    const entryPath = getDaemonEntryPath()
    // Adoption and preflight share one absolute recovery budget.
    const launchStartedAtMs = Date.now()
    const recoveryDeadlineMs = launchStartedAtMs + DAEMON_RECOVERY_BUDGET_MS
    const pidPath = suppliedPidPath ?? getDaemonPidPath(runtimeDir)
    const launchNonce = suppliedLaunchNonce ?? randomUUID()
    // Consume before any await; the respawn closure must write this slot without yielding to another launch.
    const attributedReason = attributedReplaceReason
    attributedReplaceReason = null
    // Prove endpoint directories private and ours before adoption or health probes.
    ensureDaemonSocketDir(socketPath)
    let adoptionClient: DaemonClient | null = new DaemonClient({
      socketPath,
      tokenPath
    })
    try {
      // Acquire the full pair before control-only probes so an inherited deadline cannot expire in between.
      // Bound all connect/hello steps by recovery time instead of giving each a fresh timeout.
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
      return holdDaemonAdoptionLease(createPreservedDaemonHandle(runtimeDir, pidPath, mode), {
        socketPath,
        tokenPath,
        pidPath,
        connectedClient
      })
    }
    try {
      const environment = getAppEnvironment()
      const appImage = resolveAppImageDaemonLaunch({
        entryPath,
        appPath: environment.getAppPath(),
        appVersion: environment.getVersion()
      })
      const resolveGeneration = (): ReturnType<typeof resolveAppImageGenerationDaemonLaunch> =>
        resolveAppImageGenerationDaemonLaunch({ entryPath, appVersion: environment.getVersion() })
      let generation = resolveGeneration()
      const extractedGeneration = generation && 'launch' in generation ? generation.launch : null
      const preservedHandle = await prepareDaemonReplacement({
        runtimeDir,
        socketPath,
        tokenPath,
        // Match the identity recorded by surviving AppImage daemons.
        entryPath:
          extractedGeneration?.identityPath ??
          (appImage ? appImageDaemonIdentityPath(appImage) : entryPath),
        recoveryDeadlineMs,
        attributedReason,
        releaseAdoptionClient,
        preserveDaemon,
        launchNonce
      })
      if (preservedHandle) {
        return preservedHandle
      }

      // Wait only for a new launch so first-release extraction can free it from the current mount.
      if (
        generation &&
        'fallback' in generation &&
        generation.fallback === 'no-extracted-copy' &&
        (await waitForAppImageCopyPreExtraction())
      ) {
        generation = resolveGeneration()
      }
      const launchGeneration = generation && 'launch' in generation ? generation.launch : null
      const userDataPath = environment.getPath('userData')
      const macHandle = await launchMacDaemonFromStableBundle(
        {
          entryPath,
          userDataPath,
          runtimeDir,
          socketPath,
          tokenPath,
          pidPath,
          launchNonce,
          macosLoginSessionWatch,
          ...(spawnAdmission ? { spawnAdmission } : {})
        },
        launchStartedAtMs + MAC_STABLE_LAUNCH_HANDOFF_MS
      )
      if (macHandle) {
        return macHandle
      }
      // Lazily stage the Windows host outside the NSIS updater's kill zone; null falls back to the installed host.
      const relocatedHost = materializeRelocatedDaemonHost()
      pruneDaemonHostStaging()
      const forkEntryPath = relocatedHost ? relocatedHost.entryPath : entryPath
      if (generation && 'fallback' in generation) {
        console.warn(
          `[daemon] AppImage daemon host fallback reason=${generation.fallback}: starting it on Electron, ${appImage ? 'from its own mount' : 'from the current mount'}`
        )
      }
      let launched
      try {
        launched = await launchDaemonChild({
          entryPath,
          forkEntryPath,
          relocatedExecPath: relocatedHost?.execPath,
          appImage: relocatedHost ? undefined : (appImage ?? undefined),
          extractedGeneration: launchGeneration ?? undefined,
          userDataPath,
          socketPath,
          tokenPath,
          pidPath,
          launchNonce,
          macosLoginSessionWatch,
          startupTimeoutMs,
          ...(spawnAdmission ? { spawnAdmission } : {})
        })
      } catch (error) {
        if (!(error instanceof DaemonEndpointUnavailableError) || error.reason !== 'occupied') {
          throw error
        }
        // Adopt the endpoint winner; retrying launch loses the same race and strands persistent sessions.
        console.warn(
          '[daemon] Endpoint was taken by another daemon during startup — adopting it instead'
        )
        // Adoption repairs PID records that name another incarnation.
        return await holdDaemonAdoptionLease(createPreservedDaemonHandle(runtimeDir, pidPath), {
          socketPath,
          tokenPath,
          pidPath
        })
      }

      try {
        return await holdDaemonAdoptionLease(
          { shutdown: () => terminateLaunchedDaemonChild(launched.child) },
          { socketPath, tokenPath, pidPath, expectedIdentity: launched.identity }
        )
      } catch (error) {
        if (error instanceof DaemonEndpointOwnershipError) {
          await terminateLaunchedDaemonChild(launched.child)
          unlinkOwnedDaemonPidFile(pidPath, launched.identity.pid, launched.identity.launchNonce)
          throw error
        }
        // Another client may adopt this child; remove its PID record only after exit.
        let pidRecordRemoved = false
        const removeExitedPidRecord = (): void => {
          if (pidRecordRemoved) {
            return
          }
          pidRecordRemoved = true
          unlinkOwnedDaemonPidFile(pidPath, launched.identity.pid, launched.identity.launchNonce)
        }
        launched.child.once('exit', removeExitedPidRecord)
        if (childProcessHasExited(launched.child)) {
          launched.child.off('exit', removeExitedPidRecord)
          removeExitedPidRecord()
        }
        throw error
      }
    } catch (error) {
      releaseAdoptionClient()
      // A publisher refuses endpoints it cannot prove dead; try adopting the owner before falling back to local PTYs.
      // Recovery time bounds the replacement decision; rescue adoption needs its own usable probe budget.
      if (await probeSocket(socketPath)) {
        console.warn(
          '[daemon] DEGRADED MODE: adopting the daemon that owns the endpoint after a replacement could not publish onto it. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          // Rescue adoption failed; preserve the original launch error.
        }
      }
      throw error
    }
  }
}
