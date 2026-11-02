/** A slot this connect uploaded whose candidate then failed its start check is deleted, so the next connect re-uploads it instead of relaunching the same broken bytes. */
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { orcadGcPinnedDirNames } from '../managed-server/activation/orcad-activation-record'
import {
  probeOrcadSlotReadiness,
  provenLiveDaemonVersion
} from '../managed-server/lifecycle/orcad-managed-version-gc'
import { isOrcadInstallDirLive } from '../managed-server/install/orcad-remote-gc'
import { removeRemoteInstallVersionDir } from '../managed-server/install/remote-install-gc'
import {
  ORCAD_INSTALL_MODEL,
  remoteInstallDirName
} from '../managed-server/install/remote-install-model'
import { readOrcadGcTransactionPins } from '../ssh/orcad-gc-transaction-pins'
import { orcadSlotDir, type OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import type { OrcadDeployResult } from '../ssh/orcad-remote-deploy'

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
    if (!(await mayRemove(slot, version))) {
      console.warn(`[wsl-orcad] Kept failed orcad ${version}: it may still be in use.`)
      return
    }
    const removed = await removeRemoteInstallVersionDir(
      slot.conn,
      ORCAD_INSTALL_MODEL,
      orcadSlotDir(slot, version),
      slot.host,
      { isDirLive: (dir) => isOrcadInstallDirLive(slot, dir) }
    )
    console.warn(
      removed
        ? `[wsl-orcad] Removed orcad ${version}, which failed its start check after install.`
        : `[wsl-orcad] Kept failed orcad ${version}: it is locked, incomplete or running.`
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
  // With nothing active nothing serves terminals, and only this connect's rejected candidate ran here.
  const liveDaemonVersion = record.active
    ? provenLiveDaemonVersion(await probeOrcadSlotReadiness(slot, record.active))
    : null
  if (liveDaemonVersion === undefined) {
    return false
  }
  if (orcadGcPinnedDirNames(record, liveDaemonVersion).includes(dirName)) {
    return false
  }
  const transaction = await readOrcadGcTransactionPins(slot)
  return transaction.state === 'pinned' && !transaction.dirNames.includes(dirName)
}
