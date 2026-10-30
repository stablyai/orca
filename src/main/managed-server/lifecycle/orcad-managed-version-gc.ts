import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { orcadSlotDir, type OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import { gcOldOrcadVersions } from '../install/orcad-remote-gc'
import { nodeRuntimeStorePins } from '../../ssh/pinned-runtime-host-target'

/** null proves no daemon; undefined means its version is unknown. */
export function provenLiveDaemonVersion(readiness: ServeReadiness): string | null | undefined {
  const daemon = readiness.health?.terminalDaemon
  if (daemon?.state === 'live' && daemon.buildVersion) {
    return daemon.buildVersion
  }
  return daemon?.state === 'absent' ? null : undefined
}

export type ManagedOrcadPruneArgs = {
  slot: OrcadSlotOptions
  serverTarget: NodeRuntimeTarget
  activeVersion: string
  readiness: ServeReadiness
}

/** True only when GC ran and left no stale version dir behind. */
export async function pruneManagedOrcadVersions(args: ManagedOrcadPruneArgs): Promise<boolean> {
  const liveDaemonVersion = provenLiveDaemonVersion(args.readiness)
  // Unknown daemon versions could still execute from any candidate tree; skip GC.
  if (liveDaemonVersion === undefined) {
    return false
  }
  try {
    return await gcOldOrcadVersions({
      conn: args.slot.conn,
      host: args.slot.host,
      remoteHome: args.slot.remoteHome,
      currentDirAbsPath: orcadSlotDir(args.slot, args.activeVersion),
      record: await readOrcadActivationRecord(args.slot),
      liveDaemonVersion,
      // Default and compat builds share one runtime store.
      nodeRuntimePins: nodeRuntimeStorePins(args.serverTarget),
      signal: args.slot.signal
    })
  } catch (error) {
    // Cleanup must not fail completed deploys; later connects retry.
    console.warn('[orcad-gc] Pruning old orcad versions failed:', error)
    return false
  }
}
