/**
 * After a managed deploy or update, removes this host's older orcad version dirs that are
 * proven stopped (design D10). Pins come from gcOldOrcadVersions: the active version, the
 * rollback target, journaled versions, and the version the live terminal daemon was forked
 * from. Anything the host cannot answer about is kept.
 */
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { ServeReadiness } from '../server/serve-readiness'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { orcadSlotDir, type OrcadSlotOptions } from './orcad-recovery-slot'
import { gcOldOrcadVersions } from './orcad-remote-gc'
import { relayRuntimeStorePins } from './ssh-relay-runtime-ladder'

/** The daemon's build when the readiness proves it; undefined when it cannot say. */
export function provenLiveDaemonVersion(readiness: ServeReadiness): string | null | undefined {
  const daemon = readiness.health?.terminalDaemon
  if (daemon?.state === 'live' && daemon.buildVersion) {
    return daemon.buildVersion
  }
  // A daemon that answered as absent forked from nothing; degraded or unreported proves nothing.
  return daemon?.state === 'absent' ? null : undefined
}

export async function pruneManagedOrcadVersions(args: {
  slot: OrcadSlotOptions
  serverTarget: NodeRuntimeTarget
  activeVersion: string
  readiness: ServeReadiness
}): Promise<void> {
  const liveDaemonVersion = provenLiveDaemonVersion(args.readiness)
  // Why skip: without the daemon's version, GC could remove the tree a live daemon runs from.
  if (liveDaemonVersion === undefined) {
    return
  }
  try {
    await gcOldOrcadVersions({
      conn: args.slot.conn,
      host: args.slot.host,
      remoteHome: args.slot.remoteHome,
      currentDirAbsPath: orcadSlotDir(args.slot, args.activeVersion),
      record: await readOrcadActivationRecord(args.slot),
      liveDaemonVersion,
      // Why the relay's pins: a compat orcad and a rung A relay share one runtime store.
      nodeRuntimePins: relayRuntimeStorePins(args.serverTarget),
      signal: args.slot.signal
    })
  } catch (error) {
    // Best effort: the deploy already succeeded, and the next connect tries again.
    console.warn('[orcad-gc] Pruning old orcad versions failed:', error)
  }
}
