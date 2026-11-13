import { createHash } from 'node:crypto'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { ProtectedSecretRetentionUpdate } from '../../../credentials/protected-secret-persistence'
import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../../profile-state/document-parts/profile-state-document-parts'
import {
  appendProfileStateOwnValue,
  type ProfileStateDomainPatch
} from '../../profile-state/documents/profile-state-domain-patches'
import type { ProfileStateSplitSnapshots } from './profile-state-split-snapshots'
import type {
  ProfileStateDomainReplacement,
  PreparedProfileStateWrite
} from './profile-state-authority'
import {
  serializeProfileStateDomainFragment,
  serializeSelectiveProfileStateDomainFragment,
  extractProfileStateDomainPayload
} from './profile-state-authority-writes'
import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'

export type CapturedProfileStateWrite = {
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  acknowledge: () => void
  unchanged?: boolean
} & (
  | { write: PreparedProfileStateWrite; stateHash: null; payload?: never }
  | { write?: never; stateHash: string; payload: Buffer }
)

type PreparedWriteProjection = {
  snapshots: ProfileStateSplitSnapshots
  stateToSave: Record<string, unknown>
  complete: boolean
  secretSubs: readonly SecretSentinelSubstitution[]
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  protectedStorageDegraded?: boolean
  pendingEncryption?: boolean
  automationRuns?: readonly AutomationRun[]
  serializeRoot?: () => {
    payload: Buffer
    stateHash: string
    protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  }
}

export function capturePreparedProfileStateWrite({
  snapshots,
  stateToSave,
  complete,
  secretSubs,
  protectedSecretUpdates,
  protectedStorageDegraded = false,
  pendingEncryption = false,
  automationRuns,
  serializeRoot
}: PreparedWriteProjection): CapturedProfileStateWrite {
  const candidates = new Map<string, unknown>()
  let completeFingerprint: string | undefined
  const acknowledge = () => snapshots.acknowledge(candidates, completeFingerprint)
  if (!complete) {
    // A selective dispatch breaks the previous complete-save proof, even if it later fails.
    snapshots.invalidateCompleteWrite()
  }
  if (complete && 'toJSON' in stateToSave && typeof stateToSave.toJSON === 'function') {
    snapshots.invalidateCompleteWrite()
    const built = serializeRoot!()
    const state: unknown = JSON.parse(built.payload.toString('utf8'))
    for (const domain of PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()) {
      candidates.set(
        domain,
        state !== null && typeof state === 'object'
          ? Object.getOwnPropertyDescriptor(state, domain)?.value
          : undefined
      )
    }
    return { ...built, acknowledge }
  }
  const domainOrder: string[] = []
  const replacements: ProfileStateDomainReplacement[] = []
  const patches: ProfileStateDomainPatch[] = []
  const fingerprint = complete ? createHash('sha1') : undefined
  const hashField = (value: string): void => {
    fingerprint?.update(`${value.length}:`, 'utf16le').update(value, 'utf16le')
  }
  hashField(protectedStorageDegraded ? 'degraded' : 'protected')
  let eligibleComplete = complete && !pendingEncryption
  let splitEqual = true
  // Complete serialization captures entries before any hook; selective reads each key in turn.
  function* selectiveEntries(): Generator<[string, unknown]> {
    for (const domain of Object.keys(stateToSave)) {
      yield [domain, stateToSave[domain]]
    }
  }
  for (const [domain, value] of complete ? Object.entries(stateToSave) : selectiveEntries()) {
    const split = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.has(domain)
    const captured = split ? snapshots.capture(domain, value) : undefined
    if (captured) {
      appendProfileStateOwnValue(domainOrder, domain)
      appendProfileStateOwnValue(patches, captured.patch)
      candidates.set(domain, captured.value)
      splitEqual &&= captured.patch.operations.length === 0
      hashField('split')
      hashField(domain)
      continue
    }
    if (split) {
      if (value === undefined && snapshots.isAbsent(domain)) {
        candidates.set(domain, undefined)
      } else {
        eligibleComplete = false
        snapshots.invalidateCompleteWrite()
      }
    }
    const fragment = complete
      ? serializeProfileStateDomainFragment(domain, value)
      : serializeSelectiveProfileStateDomainFragment(domain, value)
    const substituted = complete
      ? applySecretSentinelSubstitutions(fragment, secretSubs, '', 'text')
      : undefined
    const serialized = substituted?.payload ?? fragment
    const payload =
      serialized === '{}' ? null : extractProfileStateDomainPayload(domain, serialized)
    if (!complete || split || payload !== null) {
      appendProfileStateOwnValue(domainOrder, domain)
      appendProfileStateOwnValue(replacements, { domain, payload })
    }
    if (complete && !split && payload !== null) {
      hashField('value')
      hashField(domain)
      hashField(substituted!.stateHash)
    }
    if (split) {
      candidates.set(domain, payload === null ? undefined : JSON.parse(payload))
    }
  }
  if (complete) {
    for (const domain of PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()) {
      if (!candidates.has(domain)) {
        splitEqual &&= snapshots.isAbsent(domain)
        candidates.set(domain, undefined)
      }
    }
  }
  if (eligibleComplete) {
    completeFingerprint = fingerprint!.digest('hex')
  }
  const unchanged =
    completeFingerprint !== undefined &&
    splitEqual &&
    snapshots.matchesCompleteWrite(completeFingerprint)
  const runPayloads =
    !complete && automationRuns !== undefined
      ? automationRuns.map((run) => {
          const payload = JSON.stringify(run)
          if (payload === undefined) {
            throw new Error('Automation run is not serializable')
          }
          return payload
        })
      : undefined
  return {
    write: { domainOrder, replacements, patches, complete, runPayloads },
    stateHash: null,
    unchanged,
    protectedSecretUpdates,
    acknowledge
  }
}
