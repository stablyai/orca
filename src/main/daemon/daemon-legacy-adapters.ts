import { readFileSync, unlinkSync } from 'node:fs'
import { probeDaemonEndpoint } from './daemon-endpoint-verdict'
import { getDaemonHistoryDir as getHistoryDir } from './daemon-launch-paths'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { inspectProcessLiveness } from './daemon-process-inspection'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

// Why: a live daemon can transiently fail the probe, and dropping its token makes its sessions
// permanently unadoptable — so only a proven exit deletes. An unreadable record, EPERM or any
// other failed check leaves both files in place.
function reclaimExitedLegacyDaemonFiles(pidPath: string, tokenPath: string): void {
  let parsed
  try {
    parsed = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
  } catch {
    return
  }
  // Why: an empty record parses to pid 0, and process.kill(0, 0) probes our own process group.
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return
  }
  if (inspectProcessLiveness(parsed.pid).status !== 'exited') {
    return
  }
  // Why: fenced to the record proved dead, so a daemon that republished this name keeps its files.
  if (!unlinkOwnedDaemonPidFile(pidPath, parsed.pid, parsed.launchNonce)) {
    return
  }
  try {
    unlinkSync(tokenPath)
  } catch {
    // Best-effort
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
    const verdict = await probeDaemonEndpoint(socketPath, pidPath)
    if (verdict.status === 'exited') {
      // Why: a recycled stale pid later turns an identity check into a PowerShell spawn, so reclaim leaked pid/token files of a daemon that has exited.
      reclaimExitedLegacyDaemonFiles(pidPath, tokenPath)
      continue
    }
    if (verdict.status === 'unverifiable') {
      // Why kept: dropped, its live sessions would read as absent and their panes would start over them.
      console.warn(
        `[daemon] Keeping previous daemon v${protocolVersion} unverified: ${verdict.reason}`
      )
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath,
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
