import { compareAppVersions, isValidAppVersion } from '../../../shared/app-version'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import {
  refuseOrcadHostDowngrade,
  type OrcadHostVersionRefusal
} from '../../ssh/orcad-host-version-admission'

export type ManagedOrcadAutoUpdateSkip =
  | 'current'
  | 'no-template'
  | 'rolled-back'
  | 'failed-before'
  | 'migrating'
  | OrcadHostVersionRefusal

/** Connect honors all skips; Update retries local failures/rollbacks; Force also lifts version skips. */
export type OrcadUpdateIntent = 'connect' | 'update' | 'force'

export type ManagedOrcadAutoUpdatePlan =
  | { action: 'update' }
  | { action: 'skip'; reason: ManagedOrcadAutoUpdateSkip }

export function planManagedOrcadAutoUpdate(input: {
  record: OrcadActivationRecord
  candidateVersion: string | null
  appVersion: string
  failedBefore: boolean
}): ManagedOrcadAutoUpdatePlan {
  const { record, candidateVersion } = input
  if (!candidateVersion) {
    return { action: 'skip', reason: 'no-template' }
  }
  if (record.active === candidateVersion) {
    return { action: 'skip', reason: 'current' }
  }
  if (record.rolledBackFrom === candidateVersion) {
    return { action: 'skip', reason: 'rolled-back' }
  }
  const refusal = refuseOrcadHostDowngrade(record, candidateVersion, input.appVersion)
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  // A stopped host has no serving fallback; retry even after a prior failed attempt.
  if (record.active === null && record.previous !== null) {
    return { action: 'update' }
  }
  return input.failedBefore ? { action: 'skip', reason: 'failed-before' } : { action: 'update' }
}

export function planOrcadUpdateForIntent(
  intent: OrcadUpdateIntent,
  input: Parameters<typeof planManagedOrcadAutoUpdate>[0]
): ManagedOrcadAutoUpdatePlan {
  if (intent === 'force') {
    return { action: 'update' }
  }
  if (intent === 'connect') {
    return planManagedOrcadAutoUpdate(input)
  }
  const { rolledBackFrom: _retried, ...record } = input.record
  return planManagedOrcadAutoUpdate({ ...input, record, failedBefore: false })
}

export function admitOrcadRecordForIntent(
  intent: OrcadUpdateIntent,
  appVersion: string
): (record: OrcadActivationRecord, candidateVersion: string) => string | null {
  return (record, candidateVersion) =>
    orcadUpdateSkipRefusal(
      planOrcadUpdateForIntent(intent, {
        record,
        candidateVersion,
        appVersion,
        failedBefore: false
      }),
      record,
      candidateVersion,
      appVersion
    )
}

export function orcadUpdateSkipRefusal(
  plan: ManagedOrcadAutoUpdatePlan,
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): string | null {
  if (plan.action !== 'skip' || plan.reason === 'current') {
    return null
  }
  return plan.reason === 'rolled-back'
    ? `This host's server rolled back from ${candidateVersion}, so a connect does not activate ` +
        'it again; choose Update or Force to retry it.'
    : `Orca ${record.activeAppVersion} last ran this host's server, newer than this ` +
        `Orca (${appVersion}). Update Orca to start it.`
}

/** Content hashes cannot order updates: compare Orca versions, or for legacy hosts offer only this desktop's previously deferred build. */
export function availableManagedOrcadUpdate(input: {
  record: OrcadActivationRecord
  candidateVersion: string | null
  appVersion: string
  /** The build this desktop's last Update or connect deferred on this host. */
  deferredCandidateVersion: string | null
}): string | null {
  const { record, candidateVersion, appVersion } = input
  const hostAppVersion = record.activeAppVersion
  if (!candidateVersion || record.active === null || !isValidAppVersion(appVersion)) {
    return null
  }
  const ordered = hostAppVersion
    ? isValidAppVersion(hostAppVersion) && compareAppVersions(appVersion, hostAppVersion) >= 0
    : input.deferredCandidateVersion === candidateVersion
  if (!ordered) {
    return null
  }
  // Connect rules: a build the user rolled back from is not advertised again.
  const plan = planManagedOrcadAutoUpdate({
    record,
    candidateVersion,
    appVersion,
    failedBefore: false
  })
  return plan.action === 'update' ? candidateVersion : null
}
