/** Reuse SSH update admission: keep newer, rolled-back or launch-rejected incumbents serving; fenced activation replans before committing. */
import {
  ORCAD_HOST_NEWER_DEFERRAL_CODE,
  ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE,
  type WslHostDeferredUpdate
} from '../../shared/wsl-host-types'
import { refuseOrcadHostDowngrade } from '../ssh/orcad-host-version-admission'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { isWaitingOrcadUpdateDeferral } from '../managed-server/lifecycle/orcad-managed-auto-update'
import {
  orcadUpdateSkipRefusal,
  planOrcadUpdateForIntent,
  type ManagedOrcadAutoUpdatePlan,
  type OrcadUpdateIntent
} from '../managed-server/lifecycle/orcad-managed-update-decision'
import {
  orcadUpdateFailureThisLaunch,
  recordOrcadUpdateFailedThisLaunch,
  type OrcadUpdateFailure,
  type OrcadUpdateFailureHost
} from '../managed-server/lifecycle/orcad-managed-update-failure-memory'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/orcad-installed-activation'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { adoptRunningOrcadVersion } from '../ssh/orcad-running-version-adoption'
import type { WslOrcadLaunch } from './wsl-orcad-deploy'

type WslOrcadReadyLaunch = Extract<WslOrcadLaunch, { outcome: 'ready' }>

export type WslOrcadUpdateAdmission =
  | {
      action: 'serve'
      version: string
      readiness: ServeReadiness
      deferredUpdate: WslHostDeferredUpdate | null
    }
  /** Another run holds the host fence; a later connect adopts or deploys. */
  | { action: 'defer'; deferredUpdate: WslHostDeferredUpdate }
  /** Deploy this app's build on this record. */
  | { action: 'deploy'; record: OrcadActivationRecord }

export async function admitWslOrcadUpdate(args: {
  slot: OrcadSlotOptions
  record: OrcadActivationRecord
  candidateVersion: string
  appVersion: string
  host: OrcadUpdateFailureHost
  intent: OrcadUpdateIntent
  /** A project move to this distro runs here: a redeploy would cut it off, even when forced. */
  moveRunning?: boolean
}): Promise<WslOrcadUpdateAdmission> {
  const { record, candidateVersion, appVersion } = args
  if (!record.active) {
    return { action: 'deploy', record }
  }
  const failure = orcadUpdateFailureThisLaunch(args.host)
  const plan = planOrcadUpdateForIntent(args.intent, {
    record,
    candidateVersion,
    appVersion,
    failedBefore: failure !== null
  })
  const heldForMove = args.moveRunning === true && plan.action === 'update'
  if (!heldForMove && (plan.action !== 'skip' || plan.reason === 'current')) {
    return { action: 'deploy', record }
  }
  const adopted = await adoptRunningOrcadVersion(args.slot, record, candidateVersion)
  if (!adopted) {
    // Nothing active any more: deploy on the record the wake read; its fenced admission re-plans.
    return { action: 'deploy', record: await readOrcadActivationRecord(args.slot) }
  }
  if ('outcome' in adopted) {
    const { candidateVersion: version, code, reason, forceable } = adopted
    return {
      action: 'defer',
      deferredUpdate: { candidateVersion: version, code, reason, forceable: forceable === true }
    }
  }
  return {
    action: 'serve',
    version: adopted.version,
    readiness: adopted.readiness,
    deferredUpdate:
      adopted.version === candidateVersion
        ? null
        : heldForMove
          ? {
              candidateVersion,
              code: ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE,
              reason:
                'A project is moving to this WSL host; its server updates once the move finishes.',
              forceable: false
            }
          : skippedUpdateHint(plan, failure, record, candidateVersion, appVersion)
  }
}

/** The launch an admission ends in, or the record to deploy on. */
export async function admitWslOrcadLaunch(
  args: Parameters<typeof admitWslOrcadUpdate>[0],
  distro: string,
  readyLaunch: (serving: {
    fullVersion: string
    readiness: ServeReadiness
  }) => Promise<WslOrcadReadyLaunch>
): Promise<WslOrcadLaunch | OrcadActivationRecord> {
  const admission = await admitWslOrcadUpdate(args)
  if (admission.action === 'deploy') {
    return admission.record
  }
  if (admission.action === 'defer') {
    return { outcome: 'deferred', distro, ...admission.deferredUpdate }
  }
  const ready = await readyLaunch({
    fullVersion: admission.version,
    readiness: admission.readiness
  })
  return admission.deferredUpdate ? { ...ready, deferredUpdate: admission.deferredUpdate } : ready
}

/** Offer Update/Force for retriable host deferrals; newer hosts get no hint because Update cannot change that refusal. */
function skippedUpdateHint(
  plan: ManagedOrcadAutoUpdatePlan,
  failure: OrcadUpdateFailure | null,
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): WslHostDeferredUpdate | null {
  if (plan.action !== 'skip') {
    return null
  }
  if (plan.reason === 'failed-before' && failure) {
    return { candidateVersion, ...failure, forceable: true }
  }
  const refusal =
    plan.reason === 'rolled-back'
      ? orcadUpdateSkipRefusal(plan, record, candidateVersion, appVersion)
      : null
  return refusal
    ? {
        candidateVersion,
        code: ORCAD_ACTIVATION_POLICY_REFUSED_CODE,
        reason: refusal,
        forceable: true
      }
    : null
}

/** Do not retry rejected/thrown incumbent updates this launch, matching SSH. Waits/policy refusals never attempted activation and record no failure. */
export function recordWslOrcadUpdateFailure(
  host: OrcadUpdateFailureHost,
  incumbentVersion: string | null,
  failure: OrcadUpdateFailure | null
): void {
  if (incumbentVersion && failure) {
    recordOrcadUpdateFailedThisLaunch(host, failure)
  }
}

export function wslOrcadDeferralFailure(deployed: {
  code: string
  reason: string
}): OrcadUpdateFailure | null {
  return isWaitingOrcadUpdateDeferral(deployed.code) ||
    deployed.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    ? null
    : { code: deployed.code, reason: deployed.reason }
}

/** A policy refusal over a host a newer Orca runs gets its own code: an Update cannot pass it. */
export async function wslOrcadDeferralCode(
  slot: OrcadSlotOptions,
  deployed: { code: string; fullVersion: string },
  appVersion: string
): Promise<string> {
  if (deployed.code !== ORCAD_ACTIVATION_POLICY_REFUSED_CODE) {
    return deployed.code
  }
  const record = await readOrcadActivationRecord(slot).catch(() => null)
  return record && refuseOrcadHostDowngrade(record, deployed.fullVersion, appVersion)
    ? ORCAD_HOST_NEWER_DEFERRAL_CODE
    : deployed.code
}
