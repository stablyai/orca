import {
  isDaemonPtyCwdDenialDiverged,
  trackDaemonPtyCwdDeniedIfDiverged
} from './daemon-adoption-telemetry-event'
import { readDaemonPidRecord, sameEndpointIdentity } from './daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { recordMacDaemonProtectedPathDenial } from './daemon-tcc-attribution'

export async function handleDaemonPtyCwdDenial(args: {
  cwd: string | undefined
  cwdReadableByDaemon: boolean | undefined
  spawningIdentity: DaemonEndpointIdentity | null
  pidPath: string | null
  degrade: (() => Promise<boolean>) | null | undefined
}): Promise<void> {
  if (!isDaemonPtyCwdDenialDiverged(args.cwd, args.cwdReadableByDaemon)) {
    return
  }
  const record = readDaemonPidRecord(args.pidPath)
  const matches =
    args.spawningIdentity &&
    record?.startedAtMs != null &&
    record.launchNonce &&
    sameEndpointIdentity(args.spawningIdentity, {
      pid: record.pid,
      startedAtMs: record.startedAtMs,
      launchNonce: record.launchNonce
    })
  trackDaemonPtyCwdDeniedIfDiverged(args.cwd, args.cwdReadableByDaemon, args.pidPath, {
    pidRecord: matches ? record : null
  })
  if (!matches || !record) {
    return
  }
  recordMacDaemonProtectedPathDenial(record, args.pidPath)
  // The reporting spawn stays owned by its daemon; subsequent admissions use fallback.
  try {
    await args.degrade?.()
  } catch {
    // A failed routing transition must not abandon the session that already spawned.
  }
}
