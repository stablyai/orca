/** A slot this connect uploaded whose candidate then failed its start check is deleted, so the next connect re-uploads it instead of relaunching the same broken bytes. */
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { orcadGcPinnedDirNames } from '../managed-server/activation/orcad-activation-record'
import {
  probeOrcadSlotReadiness,
  provenLiveDaemonVersion
} from '../managed-server/lifecycle/orcad-managed-version-gc'
import { withOrcadActivationLock } from '../managed-server/activation/orcad-activation-lock'
import { removeRemoteInstallVersionDir } from '../managed-server/install/remote-install-gc'
import {
  ORCAD_INSTALL_MODEL,
  remoteInstallDirName
} from '../managed-server/install/remote-install-model'
import { readOrcadGcTransactionPins } from '../ssh/orcad-gc-transaction-pins'
import { orcadSlotDir, type OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import type { OrcadDeployResult } from '../ssh/orcad-remote-deploy'
import { isWslOrcadSlotInUse } from './wsl-orcad-slot-process-probe'

export async function removeFailedFreshWslOrcadInstall(
  slot: OrcadSlotOptions,
  deployed: OrcadDeployResult
): Promise<void> {
  if (
    deployed.outcome !== 'installed-not-activated' ||
    !deployed.startCheckFailed ||
    !deployed.freshlyInstalled
  ) {
    return
  }
  const version = deployed.fullVersion
  try {
    // Under the activation fence, so no activator can preflight or launch this slot meanwhile.
    const outcome = await withOrcadActivationLock(
      slot,
      async () => {
        if (!(await mayRemove(slot, version))) {
          return 'pinned'
        }
        const removed = await removeRemoteInstallVersionDir(
          slot.conn,
          ORCAD_INSTALL_MODEL,
          orcadSlotDir(slot, version),
          slot.host,
          { isDirLive: (dir) => isWslOrcadSlotInUse(slot, dir) }
        )
        return removed ? 'removed' : 'in-use'
      },
      () => 'fenced'
    )
    console.warn(
      outcome === 'removed'
        ? `[wsl-orcad] Removed orcad ${version}, which failed its start check after install.`
        : `[wsl-orcad] Kept failed orcad ${version} (${outcome}): it may still be in use.`
    )
  } catch (error) {
    // The connect already failed; a cleanup error must not replace its reason.
    console.warn(`[wsl-orcad] Could not remove failed orcad ${version}:`, error)
  }
}

/** The GC's pins: active, rollback target, the active daemon's build and any journaled slot. */
async function mayRemove(slot: OrcadSlotOptions, version: string): Promise<boolean> {
  const dirName = remoteInstallDirName(ORCAD_INSTALL_MODEL, version)
  const record = await readOrcadActivationRecord(slot)
  // Nothing active serves terminals; a daemon the rejected candidate left here is caught by the process probe.
  const liveDaemonVersion = record.active
    ? provenLiveDaemonVersion(await probeOrcadSlotReadiness(slot, record.active))
    : null
  if (liveDaemonVersion === undefined) {
    return false
  }
  if (orcadGcPinnedDirNames(record, liveDaemonVersion).includes(dirName)) {
    return false
  }
  const transaction = await readOrcadGcTransactionPins(slot, { callerHoldsFence: true })
  return transaction.state === 'pinned' && !transaction.dirNames.includes(dirName)
}
