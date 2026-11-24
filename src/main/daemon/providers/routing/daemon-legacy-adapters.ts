import { readFileSync } from 'node:fs'
import {
  endpointIsProvenDead,
  probeSocketConnect
} from '../../endpoint/publication/daemon-endpoint-probe'
import { parseDaemonPidFile } from '../../endpoint/identity/daemon-pid-file-parse'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from '../../launch/daemon-launch-paths'
import { inspectLegacyDaemonRecord } from '../../launch/daemon-legacy-process-liveness'
import { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  unlinkDaemonPidFileWhen,
  unlinkOwnedDaemonPidFile,
  unlinkOwnedDaemonTokenFile
} from '../../launch/daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from '../../protocol/daemon-protocol-version'

function readTokenIfPresent(tokenPath: string): string | null {
  try {
    return readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return null
  }
}

// Dropping a live daemon's token strands its sessions, so only a proven exit reclaims, and
// each unlink is fenced to the bytes inspected so a republished record or token survives.
async function reclaimExitedLegacyDaemonFiles(
  runtimeDir: string,
  protocolVersion: number
): Promise<void> {
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  // Read before the record check: a replacement writes its token only after its record.
  const token = readTokenIfPresent(tokenPath)
  const verdict = inspectLegacyDaemonRecord(runtimeDir, protocolVersion)
  let reclaimed = false
  switch (verdict.status) {
    case 'absent':
      reclaimed = true
      break
    case 'exited':
      reclaimed = unlinkOwnedDaemonPidFile(pidPath, verdict.record.pid, verdict.record.launchNonce)
      break
    case 'malformed':
      // A publishing daemon's record is empty until written; only a dead endpoint proves it torn.
      if (
        endpointIsProvenDead(
          await probeSocketConnect(getDaemonSocketPath(runtimeDir, protocolVersion))
        )
      ) {
        reclaimed = unlinkDaemonPidFileWhen(
          pidPath,
          (content) => parseDaemonPidFile(content) === null
        )
      }
      break
    case 'unverifiable':
      console.warn(`[daemon] Keeping protocol v${protocolVersion} daemon files: ${verdict.reason}`)
      break
    case 'live':
      break
  }
  if (reclaimed && token !== null) {
    unlinkOwnedDaemonTokenFile(tokenPath, token)
  }
}

// Isolated runtimes must keep discovery history outside app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      await reclaimExitedLegacyDaemonFiles(runtimeDir, protocolVersion)
      continue
    }
    // Preserve old-protocol sessions without respawning into new code and environment semantics.
    // Cleanup history so a later protocol reusing the session ID cannot restore stale scrollback.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
