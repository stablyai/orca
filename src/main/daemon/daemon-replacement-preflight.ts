import { getAppEnvironment } from '../../shared/app-environment'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
import { migrateLegacyDaemonScope } from './daemon-cgroup-scope'
import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { DaemonEndpointOwnershipError } from './daemon-endpoint-adoption'
import { checkDaemonHealth, getMacDaemonSystemResolverHealth } from './daemon-health'
import {
  DAEMON_SOCKET_PROBE_TIMEOUT_MS,
  getAliveDaemonSessionCount,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { trackDaemonReplaced } from './daemon-lifecycle-event'
import { getDaemonLaunchIdentity } from './daemon-pid-identity'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'
import { getDaemonPidPath, type DaemonProcessHandle } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { inspectDaemonHostImage } from './daemon-host-image'
import { PROTOCOL_VERSION } from './types'

// Cap rapid hello-reset retries as well as elapsed time to prevent a hot loop.
export const WEDGED_DAEMON_GRACE_RETRIES = 11

type PreserveDaemon = (mode?: 'degraded-new-pty-fallback') => Promise<DaemonProcessHandle>

type ReplacementPreflightOptions = {
  runtimeDir: string
  socketPath: string
  tokenPath: string
  entryPath: string
  /** Absolute deadline for the whole adopt-or-replace decision; see DAEMON_RECOVERY_BUDGET_MS. */
  recoveryDeadlineMs: number
  attributedReason: DaemonReplaceReason | null
  releaseAdoptionClient: () => void
  preserveDaemon: PreserveDaemon
  launchNonce: string
}

export async function prepareDaemonReplacement(
  options: ReplacementPreflightOptions
): Promise<DaemonProcessHandle | null> {
  const {
    runtimeDir,
    socketPath,
    tokenPath,
    entryPath,
    recoveryDeadlineMs,
    attributedReason,
    releaseAdoptionClient,
    preserveDaemon,
    launchNonce
  } = options
  let pendingReplacement:
    | {
        reason: Parameters<typeof trackDaemonReplaced>[0]
        liveSessionCount: number | null
      }
    | undefined
  let confirmedReplacement = false
  const health = await checkDaemonHealth(socketPath, tokenPath)
  if (health === 'healthy') {
    const pidRecord = readDaemonPidRecord(getDaemonPidPath(runtimeDir))
    if (pidRecord && migrateLegacyDaemonScope(pidRecord.pid, launchNonce)) {
      console.warn(
        `[daemon] Migrated adopted daemon PID ${pidRecord.pid} out of legacy app scope into a durable scope`
      )
    }
    // Check image loss before path mismatch can preserve it as a normal target for fresh terminals.
    const hostImage = inspectDaemonHostImage(pidRecord)
    const resolverHealth =
      hostImage.verdict === 'severed'
        ? null
        : await getMacDaemonSystemResolverHealth(socketPath, tokenPath)
    if (hostImage.verdict === 'severed') {
      const liveSessionCount = await getAliveDaemonSessionCount(
        socketPath,
        tokenPath,
        recoveryDeadlineMs
      )
      if (liveSessionCount !== 0) {
        console.warn(
          liveSessionCount === null
            ? '[daemon] Keeping daemon whose AppImage files are gone because live session state could not be verified'
            : `[daemon] Keeping daemon whose AppImage files are gone because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
        )
        return preserveDaemon('degraded-new-pty-fallback')
      }
      console.warn('[daemon] Replacing idle daemon whose AppImage files are gone')
      pendingReplacement = { reason: 'severed_host_image', liveSessionCount }
      confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)).cleaned
    } else if (resolverHealth === 'unhealthy') {
      const liveSessionCount = await getAliveDaemonSessionCount(
        socketPath,
        tokenPath,
        recoveryDeadlineMs
      )
      if (liveSessionCount !== 0) {
        console.warn(
          liveSessionCount === null
            ? '[daemon] Preserving daemon with unavailable macOS system resolver because live session state could not be verified'
            : `[daemon] Preserving daemon with unavailable macOS system resolver because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
        )
        return preserveDaemon()
      }
      console.warn('[daemon] Replacing daemon with unavailable macOS system resolver')
      pendingReplacement = {
        reason: 'unhealthy_resolver',
        liveSessionCount
      }
      confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)).cleaned
    } else {
      // Protocol health does not prove the launching app bundle still exists or matches.
      const identity = await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
      const stalePackagedBundle =
        getAppEnvironment().isPackaged() &&
        (await isDaemonStaleForCurrentBundle(
          runtimeDir,
          socketPath,
          tokenPath,
          getAppEnvironment().getVersion()
        ))
      if (identity === 'mismatch' || stalePackagedBundle) {
        // Code freshness must not cost live PTYs.
        const replacementLabel = stalePackagedBundle
          ? 'launched before the current app bundle was installed'
          : 'launched from a different app path'
        if (
          await shouldPreserveDaemonWithLiveSessions(
            socketPath,
            tokenPath,
            recoveryDeadlineMs,
            replacementLabel
          )
        ) {
          return preserveDaemon()
        }
        console.warn(
          stalePackagedBundle
            ? '[daemon] Replacing daemon launched before the current app bundle was installed'
            : '[daemon] Replacing daemon launched from a different app path'
        )
        pendingReplacement = {
          reason: stalePackagedBundle ? 'stale_bundle' : 'different_app_path',
          liveSessionCount: 0
        }
        confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION))
          .cleaned
      } else {
        const attributionHealth = await getMacDaemonTccAttributionHealth(
          runtimeDir,
          socketPath,
          tokenPath
        )
        if (attributionHealth === 'severed') {
          // Preserve live or unverified sessions; users can explicitly restart from Manage Sessions.
          const liveSessionCount = await getAliveDaemonSessionCount(
            socketPath,
            tokenPath,
            recoveryDeadlineMs
          )
          if (liveSessionCount === 0) {
            console.warn(
              '[daemon] Replacing daemon whose macOS TCC attribution is severed (spawning app binary no longer exists)'
            )
            pendingReplacement = { reason: 'severed_tcc_attribution', liveSessionCount }
            confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION))
              .cleaned
          } else {
            return preserveDaemon()
          }
        } else {
          return preserveDaemon()
        }
      }
    }
  } else {
    // Health checks can time out on live daemons; ask for sessions before replacing.
    let liveSessionCount = await getAliveDaemonSessionCount(
      socketPath,
      tokenPath,
      recoveryDeadlineMs
    )
    // Retry transient, reachable wedges within the startup budget; rejected handshakes cannot be adopted.
    let graceRetry = 0
    while (
      liveSessionCount === null &&
      health !== 'rejected' &&
      graceRetry < WEDGED_DAEMON_GRACE_RETRIES &&
      Date.now() < recoveryDeadlineMs &&
      (await probeSocket(
        socketPath,
        Math.max(1, Math.min(DAEMON_SOCKET_PROBE_TIMEOUT_MS, recoveryDeadlineMs - Date.now()))
      ))
    ) {
      liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath, recoveryDeadlineMs)
      graceRetry++
    }
    if (liveSessionCount !== null && liveSessionCount > 0) {
      if (health === 'pty-spawn-unhealthy') {
        console.warn(
          `[daemon] DEGRADED MODE: preserving daemon that failed the PTY spawn health check because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).`
        )
        return preserveDaemon('degraded-new-pty-fallback')
      }
      console.warn(
        `[daemon] Preserving daemon that failed the health check because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return preserveDaemon()
    }
    // Distinguish replacement from adoption without reporting cold starts as replacements.
    if (liveSessionCount !== null || graceRetry > 0 || health === 'rejected') {
      console.warn(
        `[daemon] Replacing daemon that failed the health check (health=${health}, liveSessions=${liveSessionCount ?? 'unverifiable'}, graceRetries=${graceRetry})`
      )
    }
    // Replacement telemetry requires confirmation below; a cold start alone is insufficient.
    pendingReplacement = {
      reason: 'failed_health_check',
      liveSessionCount
    }
  }

  // Fence the incumbent by PID before launching a competing session host.
  releaseAdoptionClient()
  const killOutcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath)
  if (killOutcome.liveOwnerSurvived) {
    // Preserve an unconfirmed live owner in degraded mode; fresh PTYs use the local provider.
    console.warn(
      '[daemon] DEGRADED MODE: adopting a daemon that could not be confirmed stopped. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
    )
    try {
      return await preserveDaemon('degraded-new-pty-fallback')
    } catch {
      // Failed adoption leaves ownership unproven; abort replacement.
      throw new DaemonEndpointOwnershipError(
        'Daemon replacement aborted: the existing daemon could not be confirmed stopped'
      )
    }
  }
  confirmedReplacement = killOutcome.killed || confirmedReplacement
  // Confirmed specific causes outrank caller attribution, which outranks generic health-check failure.
  const identifiedReplacement =
    pendingReplacement &&
    confirmedReplacement &&
    pendingReplacement.reason !== 'failed_health_check'
      ? pendingReplacement
      : null
  if (identifiedReplacement) {
    trackDaemonReplaced(identifiedReplacement.reason, identifiedReplacement.liveSessionCount)
  } else if (attributedReason) {
    trackDaemonReplaced(attributedReason, 0)
  } else if (pendingReplacement && confirmedReplacement) {
    trackDaemonReplaced(pendingReplacement.reason, pendingReplacement.liveSessionCount)
  }
  return null
}

async function shouldPreserveDaemonWithLiveSessions(
  socketPath: string,
  tokenPath: string,
  recoveryDeadlineMs: number,
  replacementLabel: string
): Promise<boolean> {
  const liveSessionCount = await getAliveDaemonSessionCount(
    socketPath,
    tokenPath,
    recoveryDeadlineMs
  )
  if (liveSessionCount === 0) {
    return false
  }
  console.warn(
    liveSessionCount === null
      ? `[daemon] Preserving daemon ${replacementLabel} because live session state could not be verified`
      : `[daemon] Preserving daemon ${replacementLabel} because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
  )
  return true
}
