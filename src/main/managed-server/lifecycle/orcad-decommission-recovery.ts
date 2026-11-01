import { writeOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import type { OrcadActivationRecoveryResult } from '../activation/orcad-activation-recovery'
import type { OrcadDecommissionRecoveryPlan } from './orcad-decommission-transaction'
import { settleOrcadDecommissionStop } from './orcad-decommission-stop'
import {
  orcadLivenessProbeCommand,
  orcadLivenessProvenExited,
  parseOrcadLiveness
} from '../install/orcad-remote-launch'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from '../../ssh/orcad-recovery-slot'

/** Only proven exit clears an interrupted decommission journal. */
export async function reconcileOrcadDecommission(
  options: OrcadSlotOptions,
  plan: OrcadDecommissionRecoveryPlan
): Promise<OrcadActivationRecoveryResult> {
  if (plan.action === 'keep-serving') {
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
  // Live or unanswered slots retain the fence; only proven exit permits commit.
  const liveness = parseOrcadLiveness(
    await execOrcadRemote(
      options,
      orcadLivenessProbeCommand(options.host, orcadSlotDir(options, plan.version))
    )
  )
  if (!orcadLivenessProvenExited(liveness)) {
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
