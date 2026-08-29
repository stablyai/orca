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
// Why: SIGKILL is delivered on return from an uninterruptible syscall, so confirm the exit
// rather than assume it — but keep the wait short, it only guards the rare wedged case.
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

/**
 * Direct-construction-only seam. Which errno a non-socket path yields is platform-specific
 * (macOS ENOTSOCK vs Linux refused), so the decision rule below cannot be driven portably
 * through real syscalls. The probe itself is covered separately; this injects its verdict.
 */
export type StaleDaemonKillTestHooks = {
  probeEndpoint?: (socketPath: string) => Promise<SocketProbeOutcome>
}

export type StaleDaemonKillOutcome = {
  /** A daemon was positively confirmed gone. Drives replacement telemetry. */
  killed: boolean
  /**
   * We could not prove the recorded daemon is gone. Its PID record and endpoint are left
   * intact and the caller must not fork a replacement beside it — that is exactly how two
   * daemons end up alive with one owning the socket and the other hosting the sessions.
   */
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
  // Why: identity is resolved once, and the record we may later remove is captured here so
  // cleanup can be fenced to this exact incarnation rather than to whatever occupies the path
  // by the time we get there.
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
      // Why: the inspection failed, which is not evidence that this PID is someone else's.
      // The endpoint is the tiebreaker, and it only settles the question when it positively
      // proves nothing is serving. A probe that merely timed out is not proof either, so
      // two inconclusive signals must preserve ownership rather than combine into a licence.
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
        // Why: ESRCH means it is already gone. Anything else (EPERM from a daemon owned by
        // another user) means it is alive and we cannot stop it — falling through to the
        // blanket catch would report "nothing alive" and authorize a duplicate beside it.
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
        // Why: re-check process identity before SIGKILL. The SIGTERM-then-wait
        // window is long enough for the pid to be recycled if the original
        // daemon died during the wait. Without this, we'd SIGKILL an unrelated
        // process that happens to now own the same pid.
        const recheck = await inspectDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)
        if (recheck === 'mismatch') {
          // Why: the pid provably no longer belongs to our daemon, so it is gone regardless
          // of what the endpoint says.
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
        } else if (recheck === 'unknown') {
          // Why: the inspection failed under load. Only an endpoint that proves nothing is
          // serving may license reclaiming — a timed-out probe is not a second opinion.
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
            // Already dead
            exited = true
          }
          // Why: issuing SIGKILL is not proof of death — a process blocked in an
          // uninterruptible syscall only dies once it returns. Claiming the kill without
          // confirming it is what let the endpoint be reclaimed out from under a daemon
          // that was still alive and still serving.
          exited = exited || (await waitForProcessExit(pid, SIGKILL_CONFIRM_WAIT_MS))
          if (!exited) {
            console.warn('[daemon] Daemon survived SIGKILL: reason=unconfirmed_exit')
          }
        }
      }
      killedDaemon = exited
      // Why: SIGTERM and SIGKILL both failed to produce an exit, so the daemon is still out
      // there holding the endpoint. Treat it as the owner rather than racing it.
      liveOwnerSurvived = liveOwnerSurvived || !exited
    }
  } catch {
    // PID file missing or process already dead
  }

  if (liveOwnerSurvived) {
    // Why: removing the record of a daemon we failed to kill is what let a replacement
    // publish its own ownership beside it. Leaving it intact keeps the exclusive PID claim
    // held, so a duplicate cannot take the endpoint.
    return { killed: killedDaemon, liveOwnerSurvived }
  }

  // Why: remove only the record belonging to the daemon we just dealt with. An unfenced
  // unlink deletes whatever occupies the path now, which after a slow kill can be a
  // replacement's freshly published ownership.
  if (recordedOwner) {
    unlinkOwnedDaemonPidFile(pidPath, recordedOwner.pid, recordedOwner.launchNonce)
  } else {
    // Why: a record we cannot parse names no owner to fence against, but leaving it in place
    // fails the next daemon's exclusive publish with EEXIST — no daemon at all. Reclaim it
    // under the same rename claim, and only while it is still unparseable, so a valid record
    // published in the meantime is left alone.
    unlinkDaemonPidFileWhen(pidPath, (content) => parseDaemonPidFile(content) === null)
  }

  // Why this only reads: removing an endpoint on another daemon's behalf is the whole defect
  // class this design retires. A replacement takes the name itself, by replacing an entry it
  // has proven dead in one rename. So the only question left here is whether something is
  // still answering — and only a positive answer withholds the fork.
  // An unclassifiable entry is no longer a reason to refuse: the publisher probes again and
  // will not overwrite anything it cannot prove dead, which makes this judgement a hint
  // rather than a correctness dependency.
  if ((await probeEndpoint(socketPath)) === 'connected') {
    return { killed: killedDaemon, liveOwnerSurvived: true }
  }
  return { killed: killedDaemon, liveOwnerSurvived }
}
