/** Pair with an already-running foreign build before considering update; an unpaired first deploy cannot census its terminals. */
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadManagedDeferral } from '../../shared/orcad-managed-runtime'
import { orcadActivationFenceRefusal } from '../managed-server/activation/orcad-activation-fence-hold'
import { OrcadActiveReadinessError, probeActiveOrcadReadiness } from './orcad-active-readiness'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import { resolveOrcadSlotIdentity, type OrcadSlotOptions } from './orcad-recovery-slot'

export type OrcadRunningAdoption = {
  version: string
  readiness: ServeReadiness
  /** Reads the adopted slot's readiness again, e.g. after it rebinds its port. */
  reprobe: () => Promise<ServeReadiness>
}

/** No foreign activation returns null for normal deploy. A held peer fence defers: deploying without pairing would only fail census (#28833). */
export async function adoptRunningOrcadVersion(
  slot: OrcadSlotOptions,
  record: OrcadActivationRecord,
  localVersion: string,
  retryClearedFence = true
): Promise<OrcadRunningAdoption | OrcadManagedDeferral | null> {
  if (!record.active || record.active === localVersion) {
    return null
  }
  // Wake only on proven server exit; idle stops leave daemon terminals alive.
  const wake = await wakeStoppedManagedOrcad(slot)
  switch (wake.outcome) {
    // Another desktop stopped it meanwhile; the deploy's own gates decide.
    case 'not-activated':
      return null
    case 'fenced': {
      // E.g. another desktop starting it after a reboot; a later connect pairs with it.
      const { cleared, ...refusal } = await orcadActivationFenceRefusal(slot, 'server start')
      if (cleared && retryClearedFence) {
        return adoptRunningOrcadVersion(slot, record, localVersion, false)
      }
      return { outcome: 'deferred', candidateVersion: localVersion, ...refusal, forceable: false }
    }
    case 'unverifiable':
      throw new OrcadActiveReadinessError(
        'unverifiable',
        `Orca ${record.active} runs this host's server, but its process state is unverifiable, ` +
          'so it was left as it is. Try connecting again.'
      )
    case 'recovery-refused':
      throw new Error(wake.reason)
    case 'serving':
    case 'started':
      break
  }
  // Re-read activation because wake follows peer changes to the current record.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active || active === localVersion) {
    return null
  }
  const identity = await resolveOrcadSlotIdentity(slot, active)
  const reprobe = () =>
    probeActiveOrcadReadiness(
      { ...slot, remoteInstallDir: identity.remoteDir },
      { buildHash: identity.buildHash, fullVersion: identity.version }
    )
  return { version: active, readiness: await reprobe(), reprobe }
}
