/**
 * The SSH connect's update decision on a WSL connect: a newer build, the one the host rolled back
 * from, or one already rejected this launch keeps the incumbent serving, adopted as an SSH first
 * deploy adopts it. The fenced activation applies the same plan again.
 */
import {
  ORCAD_HOST_NEWER_DEFERRAL_CODE,
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
  if (plan.action !== 'skip' || plan.reason === 'current') {
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

/**
 * Keeps Update and Force offered on a connect that skipped this app's build for this host's own
 * reasons. A newer host gets no hint: an Update keeps that skip, and nothing here updates it.
 */
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

/**
 * As SSH's connect: an update over an incumbent that was rejected or threw is not retried this
 * launch. Null failures (a wait or a policy refusal) never tried it.
 */
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
