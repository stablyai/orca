import { PROFILE_STATE_DOCUMENT_VERSION } from './profile-state-database-schema'
import { hashProfileStateJson } from './profile-state-documents'
import type { AutomationRunsWritePreparation } from './profile-state-automation-runs'
import type {
  ProfileStateDomainMutation,
  ProfileStateDomainTransaction
} from './profile-state-domain-writes'

export type PreparedProfileStateMutation = ProfileStateDomainMutation & {
  domainVersion: number
  payloadHash: string | null
  automationRuns?: AutomationRunsWritePreparation
}

export function validateProfileStateDomainTransaction(
  transaction: ProfileStateDomainTransaction
): void {
  if (!Number.isSafeInteger(transaction.expectedRevision) || transaction.expectedRevision < 0) {
    throw new Error('Profile state expected revision is invalid')
  }
  if (
    !Array.isArray(transaction.replacements) ||
    (transaction.replacements.length === 0 && transaction.automationRunsAfter === undefined)
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
}

export function prepareProfileStateDomainMutation(
  replacement: ProfileStateDomainMutation
): PreparedProfileStateMutation {
  const payloadHash =
    replacement.payload === null ? null : hashProfileStateJson(replacement.payload)
  if (replacement.payload !== null) {
    try {
      JSON.parse(replacement.payload)
    } catch {
      throw new Error(`Profile state domain payload is invalid JSON: ${replacement.domain}`)
    }
  }
  return {
    ...replacement,
    domainVersion: replacement.domainVersion ?? PROFILE_STATE_DOCUMENT_VERSION,
    payloadHash
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
