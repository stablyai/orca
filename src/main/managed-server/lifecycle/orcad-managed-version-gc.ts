import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import {
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from '../../ssh/orcad-recovery-slot'
import { probeActiveOrcadReadiness } from '../../ssh/orcad-active-readiness'
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
  keepStagedWithinDays?: number
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
      ...(args.keepStagedWithinDays !== undefined
        ? { keepStagedWithinDays: args.keepStagedWithinDays }
        : {}),
      signal: args.slot.signal
    })
  } catch (error) {
    // Cleanup must not fail completed deploys; later connects retry.
    console.warn('[orcad-gc] Pruning old orcad versions failed:', error)
    return false
  }
}

/** GC otherwise runs only after an activation, so each deferred release left its staged slot behind (#34149). */
export async function pruneSupersededOrcadCandidates(
  slot: OrcadSlotOptions,
  serverTarget: NodeRuntimeTarget,
  candidateVersion: string
): Promise<void> {
  let readiness: ServeReadiness
  try {
    const active = (await readOrcadActivationRecord(slot)).active
    if (!active) {
      return
    }
    const identity = await resolveOrcadSlotIdentity(slot, active)
    readiness = await probeActiveOrcadReadiness(
      { ...slot, remoteInstallDir: identity.remoteDir },
      { buildHash: identity.buildHash, fullVersion: identity.version }
    )
  } catch (error) {
    // Without the incumbent's daemon version a staged tree may still be executing.
    console.warn('[orcad-gc] Skipped pruning staged orcad versions:', error)
    return
  }
  await pruneManagedOrcadVersions({
    slot,
    serverTarget,
    activeVersion: candidateVersion,
    readiness,
    keepStagedWithinDays: STAGED_BUILD_KEEP_DAYS
  })
}

// Desktops on different releases share hosts; without a grace period each re-uploads what the other pruned.
const STAGED_BUILD_KEEP_DAYS = 3
