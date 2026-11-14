import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { ProtectedSecretRetentionUpdate } from '../../../credentials/protected-secret-persistence'
import {
  appendProfileStateOwnValue,
  type ProfileStateDomainPatch
} from '../../profile-state/documents/profile-state-domain-patches'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'
import type { WorkspaceSessionFieldCapture } from './workspace-session-field-capture'
import { ProfileStateSaveIntent } from './profile-state-save-intent'
import type {
  ProfileStateDomainReplacement,
  PreparedProfileStateWrite
} from './profile-state-authority'
import {
  serializeSelectiveProfileStateDomainFragment,
  extractProfileStateDomainPayload
} from './profile-state-authority-writes'

export type CapturedProfileStateWrite = {
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  acknowledge: () => void
  bypassEquality?: boolean
} & (
  | { write: PreparedProfileStateWrite; stateHash: null; payload?: never }
  | {
      write?: never
      stateHash: string
      payload: Buffer
      domains?: readonly ProfileStateDomainReplacement[]
    }
)

type PreparedWriteProjection = {
  fields: WorkspaceSessionFieldCapture
  stateToSave: Record<string, unknown>
  dirtyDomains: ReadonlySet<string> | null
  complete: boolean
  pendingEncryption?: boolean
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  automationRuns?: readonly AutomationRun[]
  serializeRoot?: () => {
    domains?: readonly ProfileStateDomainReplacement[]
    payload: Buffer
    stateHash: string
    protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  }
}

export function capturePreparedProfileStateWrite({
  fields,
  stateToSave,
  dirtyDomains,
  complete,
  pendingEncryption = false,
  protectedSecretUpdates,
  automationRuns,
  serializeRoot
}: PreparedWriteProjection): CapturedProfileStateWrite {
  const candidates: NonNullable<ReturnType<WorkspaceSessionFieldCapture['snapshot']>>[] = []
  const acknowledge = () => fields.acknowledge(candidates)
  if (complete) {
    // Native root hooks can retain the whole holder; never expose an owned graph to them.
    const descriptor = Object.getOwnPropertyDescriptor(stateToSave, 'toJSON')
    if (
      (descriptor &&
        (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')) ||
      (!descriptor && 'toJSON' in stateToSave)
    ) {
      fields.clear()
    }
    for (const domain of WORKSPACE_SESSION_DOMAINS) {
      const candidate = fields.snapshot(
        domain,
        Object.getOwnPropertyDescriptor(stateToSave, domain)?.value
      )
      if (candidate) {
        appendProfileStateOwnValue(candidates, candidate)
      }
    }
    const serialized = serializeRoot!()
    return {
      bypassEquality: pendingEncryption,
      domains: serialized.domains,
      get payload() {
        return serialized.payload
      },
      stateHash: serialized.stateHash,
      protectedSecretUpdates: serialized.protectedSecretUpdates,
      acknowledge
    }
  }
  const domainOrder: string[] = []
  const replacements: ProfileStateDomainReplacement[] = []
  const patches: ProfileStateDomainPatch[] = []
  // Read each domain when reached: preceding native hooks may change subsequent values.
  for (const domain of Object.keys(stateToSave)) {
    const value = stateToSave[domain]
    appendProfileStateOwnValue(domainOrder, domain)
    const captured =
      dirtyDomains instanceof ProfileStateSaveIntent && dirtyDomains.hasFields(domain)
        ? fields.capture(domain, value)
        : undefined
    if (captured) {
      appendProfileStateOwnValue(patches, captured.patch)
      appendProfileStateOwnValue(candidates, captured.candidate)
    } else {
      const candidate = fields.snapshot(domain, value)
      const fragment = serializeSelectiveProfileStateDomainFragment(domain, value)
      appendProfileStateOwnValue(replacements, {
        domain,
        payload: fragment === '{}' ? null : extractProfileStateDomainPayload(domain, fragment)
      })
      if (candidate) {
        appendProfileStateOwnValue(candidates, candidate)
      }
    }
  }
  const runPayloads = automationRuns?.map((run) => {
    const payload = JSON.stringify(run)
    if (payload === undefined) {
      throw new Error('Automation run is not serializable')
    }
    return payload
  })
  return {
    write: { domainOrder, replacements, patches, complete: false, runPayloads },
    stateHash: null,
    protectedSecretUpdates,
    acknowledge
  }
}
