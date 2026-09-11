import { readFileSync } from 'node:fs'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { ExactDaemonIncarnation } from './daemon-incarnation-evidence'
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
