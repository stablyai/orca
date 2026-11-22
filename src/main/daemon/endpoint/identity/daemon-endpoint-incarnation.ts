import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import type { ExactDaemonIncarnation } from './daemon-incarnation-evidence-types'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'

export function sameEndpointIdentity(
  left: DaemonEndpointIdentity,
  right: DaemonEndpointIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.startedAtMs === right.startedAtMs &&
    left.launchNonce === right.launchNonce
  )
}

export function exactDaemonIncarnationForPidRecord(
  identity: DaemonEndpointIdentity,
  pidRecord: ParsedDaemonPid | null
): ExactDaemonIncarnation {
  return {
    identity: { ...identity },
    ...(process.platform === 'linux' &&
    pidRecord?.pid === identity.pid &&
    pidRecord.startedAtMs === identity.startedAtMs &&
    pidRecord.launchNonce === identity.launchNonce &&
    pidRecord.linuxStartTicks &&
    pidRecord.bootId
      ? {
          linuxStartTicks: pidRecord.linuxStartTicks,
          bootId: pidRecord.bootId
        }
      : {})
  }
}

export function readDaemonPidRecord(pidPath: string | null): ParsedDaemonPid | null {
  if (!pidPath) {
    return null
  }
  try {
    return parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
  } catch {
    return null
  }
}

/** For paths that must not block the main process, such as per-launch telemetry. */
export async function readDaemonPidRecordAsync(
  pidPath: string | null
): Promise<ParsedDaemonPid | null> {
  if (!pidPath) {
    return null
  }
  try {
    return parseDaemonPidFile(await readFile(pidPath, 'utf8'))
  } catch {
    return null
  }
}
