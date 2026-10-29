/**
 * A same-version WSL connect takes one activation fence instead of two: the deploy confirms the
 * slot is installed and skips its own fence, then the wake's fence re-reads the record and starts
 * the slot if it stopped. A fence the snapshot saw held, another version active by then, or a busy
 * fence all run the full deploy and wake, as before.
 */
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { wakeExpectedOrcadUnderOneFence } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadDeployOptions, OrcadDeployResult } from '../ssh/orcad-remote-deploy'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'

type DeployExtra = Pick<OrcadDeployOptions, 'preRead' | 'sameVersionFencedByCaller'>

export async function deployWslOrcadWithOneFence(
  slot: OrcadSlotOptions,
  deploy: (extra: DeployExtra) => Promise<OrcadDeployResult>,
  hinted: { preRead?: { record: OrcadActivationRecord; fenceOpen: boolean } }
): Promise<{ deployed: OrcadDeployResult; woken: boolean }> {
  if (!hinted.preRead?.fenceOpen) {
    return { deployed: await deploy(hinted), woken: false }
  }
  const first = await deploy({ ...hinted, sameVersionFencedByCaller: true })
  if (first.outcome !== 'already-active') {
    return { deployed: first, woken: false }
  }
  const wake = await wakeExpectedOrcadUnderOneFence(slot, first.fullVersion)
  if (wake.outcome === 'replan' || wake.outcome === 'fenced') {
    // The host moved since the snapshot, so this deploy takes no hints.
    return { deployed: await deploy({}), woken: false }
  }
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return { deployed: first, woken: true }
}
