import { PROFILE_STATE_DOCUMENT_VERSION } from '../database/profile-state-database-schema'
import { isProfileStateSplitDomain } from '../document-parts/profile-state-document-parts'
import './profile-state-documents'
import {
  hashProfileStatePayload as hashProfileStateJson,
  parseProfileStateRoot
} from './profile-state-document-validation'
import type { AutomationRunsWritePreparation } from '../automation-runs/profile-state-automation-runs-writer'
import type {
  ProfileStateDomainMutation,
  ProfileStateDomainTransaction
} from './profile-state-domain-writes'
import { prepareProfileStateDomainPatches } from './profile-state-domain-patches'
import type { ProfileStateExistingDocumentParts } from '../document-parts/profile-state-document-parts-storage'

export type PreparedProfileStateMutation = ProfileStateDomainMutation & {
  domainVersion: number
  payloadHash: string | null
  // Retain the checked history only for this write to avoid reparsing during normalization.
  automationRunsValue?: unknown
  /** Parsed payload of a split domain, so storing its parts does not parse it again. */
  splitDomainValue?: unknown
  existingParts?: ProfileStateExistingDocumentParts
  automationRuns?: AutomationRunsWritePreparation
}

export function validateProfileStateDomainTransaction(transaction: ProfileStateDomainTransaction) {
  if (!Number.isSafeInteger(transaction.expectedRevision) || transaction.expectedRevision < 0) {
    throw new Error('Profile state expected revision is invalid')
  }
  if (
    !Array.isArray(transaction.replacements) ||
    (transaction.replacements.length === 0 &&
      transaction.automationRunsAfter === undefined &&
      transaction.patches === undefined &&
      !transaction.complete)
  ) {
    throw new Error('Profile state domain transaction requires at least one replacement')
  }
  const domains = new Set<string>()
  for (const replacement of transaction.replacements) {
    validateProfileStateDomainMutation(replacement)
    if (domains.has(replacement.domain)) {
      throw new Error(`Profile state domain transaction repeats domain: ${replacement.domain}`)
    }
    domains.add(replacement.domain)
  }
  if (transaction.automationRunsAfter !== undefined && domains.has('automationRuns')) {
    throw new Error('Profile state automationRuns delta repeats domain: automationRuns')
  }
  if (transaction.complete !== undefined && typeof transaction.complete !== 'boolean') {
    throw new Error('Profile state complete intent is invalid')
  }
  const patches = prepareProfileStateDomainPatches(transaction.patches ?? [])
  for (const patch of patches) {
    if (domains.has(patch.domain)) {
      throw new Error(`Profile state patch repeats replacement: ${patch.domain}`)
    }
  }
  if (transaction.domainOrder !== undefined) {
    const present = new Set([...domains, ...patches.map(({ domain }) => domain)])
    if (
      !Array.isArray(transaction.domainOrder) ||
      transaction.domainOrder.length !== present.size ||
      !transaction.domainOrder.every(
        (domain: unknown) => typeof domain === 'string' && present.delete(domain)
      )
    ) {
      throw new Error('Profile state domain order is invalid')
    }
  }
  return patches
}

export function prepareProfileStateDomainMutation(
  replacement: ProfileStateDomainMutation,
  validatedValue?: { value: unknown }
): PreparedProfileStateMutation {
  const payloadHash =
    replacement.payload === null ? null : hashProfileStateJson(replacement.payload)
  let parsed: unknown
  if (replacement.payload !== null) {
    try {
      parsed = validatedValue ? validatedValue.value : JSON.parse(replacement.payload)
    } catch {
      throw new Error(`Profile state domain payload is invalid JSON: ${replacement.domain}`)
    }
  }
  return {
    domain: replacement.domain,
    payload: replacement.payload,
    now: replacement.now,
    domainVersion: replacement.domainVersion ?? PROFILE_STATE_DOCUMENT_VERSION,
    payloadHash,
    automationRunsValue: replacement.domain === 'automationRuns' ? parsed : undefined,
    splitDomainValue: isProfileStateSplitDomain(replacement.domain) ? parsed : undefined
  }
}

function validateProfileStateDomainMutation(replacement: ProfileStateDomainMutation): void {
  if (typeof replacement.domain !== 'string' || replacement.domain.length === 0) {
    throw new Error('Profile state domain name cannot be empty')
  }
  if (replacement.payload !== null && typeof replacement.payload !== 'string') {
    throw new Error(`Profile state domain payload is invalid: ${replacement.domain}`)
  }
  if (
    replacement.domainVersion !== undefined &&
    (!Number.isSafeInteger(replacement.domainVersion) || replacement.domainVersion < 1)
  ) {
    throw new Error('Profile state domain version is invalid')
  }
}

export function profileStateDomainsFromSerializedState(
  payload: Buffer
): ProfileStateDomainMutation[] {
  const serialized = payload.toString('utf8')
  if (!Buffer.from(serialized, 'utf8').equals(payload)) {
    throw new Error('Profile state payload is not valid UTF-8')
  }
  return Object.entries(parseProfileStateRoot(serialized)).map(([domain, value]) => {
    const payload = JSON.stringify(value)
    if (payload === undefined) {
      throw new Error(`Profile state domain payload is not serializable: ${domain}`)
    }
    return { domain, payload }
  })
}
