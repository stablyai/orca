import { readFileSync } from 'node:fs'
import {
  getDaemonPidPath,
  unlinkDaemonPidFileWhen,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import {
  endpointIsProvenDead,
  probeSocketConnect,
  type SocketProbeOutcome
} from './daemon-endpoint-probe'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity, isNoSuchProcessError } from './daemon-pid-identity'
import { PROTOCOL_VERSION } from './types'

const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100
// SIGKILL waits for uninterruptible syscalls, so signal delivery alone does not confirm exit.
const SIGKILL_CONFIRM_WAIT_MS = 1_000

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
  }
}

/** Inject probe verdicts because non-socket errno differs across platforms (macOS ENOTSOCK, Linux refused). */
export type StaleDaemonKillTestHooks = {
  probeEndpoint?: (socketPath: string) => Promise<SocketProbeOutcome>
}

export type StaleDaemonKillOutcome = {
  /** Confirmed daemon exit for replacement telemetry. */
  killed: boolean
  /** Daemon absence is unproven; preserve its artifacts and do not fork a competing daemon. */
  liveOwnerSurvived: boolean
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  testHooks?: StaleDaemonKillTestHooks
): Promise<StaleDaemonKillOutcome> {
  const probeEndpoint = testHooks?.probeEndpoint ?? probeSocketConnect
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  let killedDaemon = false
  let liveOwnerSurvived = false
  // Capture the inspected owner so cleanup cannot remove a later incarnation's record.
  let recordedOwner: ParsedDaemonPid | null = null
  try {
    const parsedPid = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
    recordedOwner = parsedPid
    const identity = parsedPid
      ? await inspectDaemonProcessIdentity(
          parsedPid.pid,
          socketPath,
          tokenPath,
          parsedPid.startedAtMs
        )
      : 'mismatch'
    if (
      parsedPid &&
      identity === 'unknown' &&
      !endpointIsProvenDead(await probeEndpoint(socketPath))
    ) {
      // Neither failed inspection nor an inconclusive endpoint probe proves the owner gone.
      console.warn(
        '[daemon] Preserving daemon that could not be inspected: reason=identity_probe_failed'
      )
      return { killed: false, liveOwnerSurvived: true }
    }
    if (parsedPid && identity === 'match') {
      const { pid, startedAtMs } = parsedPid
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        // Only ESRCH proves absence; other errors must not authorize a competing daemon.
        if (!isNoSuchProcessError(error)) {
          return { killed: false, liveOwnerSurvived: true }
        }
      }
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
      }
      if (!exited) {
        // Recheck identity after waiting so PID reuse cannot direct SIGKILL at an unrelated process.
        const recheck = await inspectDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)
        if (recheck === 'mismatch') {
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
        } else if (recheck === 'unknown') {
          // Unknown identity permits reclamation only when the endpoint is proven dead.
          if (endpointIsProvenDead(await probeEndpoint(socketPath))) {
            console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
            exited = true
          } else {
            console.warn(
              '[daemon] Preserving daemon that could not be identified: reason=identity_probe_failed'
            )
            liveOwnerSurvived = true
          }
        } else {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            exited = true
          }
          // A process in an uninterruptible syscall may survive SIGKILL until the syscall returns.
          exited = exited || (await waitForProcessExit(pid, SIGKILL_CONFIRM_WAIT_MS))
          if (!exited) {
            console.warn('[daemon] Daemon survived SIGKILL: reason=unconfirmed_exit')
          }
        }
      }
      killedDaemon = exited
      // Unconfirmed exit preserves ownership to prevent a competing replacement.
      liveOwnerSurvived = liveOwnerSurvived || !exited
    }
  } catch {
    // Preserve endpoint probing below when the PID record cannot be inspected.
  }

  if (liveOwnerSurvived) {
    // Keep the exclusive PID claim when shutdown cannot establish absence.
    return { killed: killedDaemon, liveOwnerSurvived }
  }

  // Fence removal to the inspected record so a concurrent replacement keeps its ownership.
  if (recordedOwner) {
    unlinkOwnedDaemonPidFile(pidPath, recordedOwner.pid, recordedOwner.launchNonce)
  } else {
    // Reclaim malformed records under a content-checked claim so valid replacements survive.
    unlinkDaemonPidFileWhen(pidPath, (content) => parseDaemonPidFile(content) === null)
  }

  // Only publishers replace dead endpoints; this probe is advisory and never removes another daemon's name.
  if ((await probeEndpoint(socketPath)) === 'connected') {
    return { killed: killedDaemon, liveOwnerSurvived: true }
  }
  return { killed: killedDaemon, liveOwnerSurvived }
}
