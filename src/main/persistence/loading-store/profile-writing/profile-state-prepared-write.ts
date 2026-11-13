import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { ProtectedSecretRetentionUpdate } from '../../../credentials/protected-secret-persistence'
import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../../profile-state/document-parts/profile-state-document-parts'
import type { ProfileStateDomainPatch } from '../../profile-state/documents/profile-state-domain-patches'
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
  automationRuns,
  serializeRoot
}: PreparedWriteProjection): CapturedProfileStateWrite {
  const candidates = new Map<string, unknown>()
  const acknowledge = snapshots.acknowledge.bind(snapshots, candidates)
  if (complete && 'toJSON' in stateToSave && typeof stateToSave.toJSON === 'function') {
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
      domainOrder.push(domain)
      patches.push(captured.patch)
      candidates.set(domain, captured.value)
      continue
    }
    const fragment = complete
      ? serializeProfileStateDomainFragment(domain, value)
      : serializeSelectiveProfileStateDomainFragment(domain, value)
    const serialized =
      complete && fragment !== '{}'
        ? applySecretSentinelSubstitutions(fragment, secretSubs, '', 'text').payload
        : fragment
    const payload =
      serialized === '{}' ? null : extractProfileStateDomainPayload(domain, serialized)
    if (!complete || split || payload !== null) {
      domainOrder.push(domain)
      replacements.push({ domain, payload })
    }
    if (split) {
      candidates.set(domain, payload === null ? undefined : JSON.parse(payload))
    }
  }
  if (complete) {
    for (const domain of PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()) {
      if (!candidates.has(domain)) {
        candidates.set(domain, undefined)
      }
    }
  }
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
    protectedSecretUpdates,
    acknowledge
  }
}
