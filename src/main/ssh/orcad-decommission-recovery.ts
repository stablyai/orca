/** Recovering an interrupted decommission from its journal entry; see orcad-decommission-transaction. */
import { writeOrcadActivationRecord } from './orcad-activation-record-store'
import type { OrcadActivationRecoveryResult } from './orcad-activation-recovery'
import type { OrcadDecommissionRecoveryPlan } from './orcad-decommission-transaction'
import { settleOrcadDecommissionStop } from './orcad-decommission-stop'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'

export async function reconcileOrcadDecommission(
  options: OrcadSlotOptions,
  plan: OrcadDecommissionRecoveryPlan
): Promise<OrcadActivationRecoveryResult> {
  if (plan.action === 'keep-serving') {
    // Nothing was sent, so the recorded version must still be the one serving.
    const identity = await resolveOrcadSlotIdentity(options, plan.version)
    return {
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: plan.version,
      readiness: await ensureOrcadSlotServing(options, identity)
    }
  }
  if (plan.action === 'resume-stop') {
    const settlement = await settleOrcadDecommissionStop(options, plan.request)
    if (settlement.state === 'unsettled') {
      return {
        outcome: 'refused',
        verdict: settlement.verdict,
        code: 'orcad_recovery_decommission_unsettled',
        reason: settlement.reason
      }
    }
    if (settlement.state === 'withdrawn') {
      return reconcileOrcadDecommission(options, {
        action: 'keep-serving',
        version: plan.request.version
      })
    }
    return reconcileOrcadDecommission(options, {
      action: 'confirm-decommissioned',
      version: plan.request.version,
      record: plan.record
    })
  }
  // Only proven exit commits; a slot that is live or unanswering keeps the fence.
  const liveness = parseOrcadLiveness(
    await execOrcadRemote(
      options,
      orcadLivenessProbeCommand(options.host, orcadSlotDir(options, plan.version))
    )
  )
  if (liveness !== 'DEAD') {
    return {
      outcome: 'refused',
      verdict: liveness === 'LIVE' ? 'live' : 'unverifiable',
      code: 'orcad_recovery_decommissioned_slot_not_exited',
      reason: `orcad ${plan.version} is recorded as stopped but is ${liveness.toLowerCase()}.`
    }
  }
  if (plan.record) {
    await writeOrcadActivationRecord(options, plan.record)
  }
  return { outcome: 'recovered', resolution: 'committed', activeVersion: null, readiness: null }
}
