import { isAdmissibleAgentSessionContextUsage } from '../../../shared/agent-session-context-usage-schema'

export function dropUnusableRowAnnotations(record: Record<string, unknown>): void {
  dropUnusableProducerLinkage(record)
  dropUnusableTurnScope(record)
  dropUnusableOwnerFence(record)
  if (record.kind === 'lifecycle-batch' && Array.isArray(record.mutations)) {
    for (const mutation of record.mutations) {
      if (isPlainObject(mutation)) {
        dropUnusableProducerLinkage(mutation)
        dropUnusableTurnScope(mutation)
        dropUnusableOwnerFence(mutation)
      }
    }
  }
  dropUnusableContextUsage(record)
}

/** Drop bad linkage, not content: readers scope by presence, so invalid IDs would hide the row. */
function dropUnusableProducerLinkage(record: Record<string, unknown>): void {
  for (const field of ['agentId', 'parentAgentId', 'providerParentRef', 'producerKind']) {
    const value = record[field]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      delete record[field]
    }
  }
  if (record.attempt !== undefined && !Number.isInteger(record.attempt)) {
    delete record.attempt
  }
}

/** Missing scopes retain legacy replay-time derivation. */
function dropUnusableTurnScope(record: Record<string, unknown>): void {
  const scope = record.turnScope
  if (
    scope !== undefined &&
    !(
      isPlainObject(scope) &&
      (scope.kind === 'thread' ||
        (scope.kind === 'turn' &&
          typeof scope.turnItemId === 'string' &&
          scope.turnItemId.length > 0))
    )
  ) {
    delete record.turnScope
  }
}

/** Unreadable provenance falls back to the creating fence. */
function dropUnusableOwnerFence(record: Record<string, unknown>): void {
  for (const key of ['ownerFence', 'executionOwner'] as const) {
    const value = record[key]
    if (value !== undefined && !(Number.isSafeInteger(value) && Number(value) >= 0)) {
      delete record[key]
    }
  }
}

/** Drop unreadable annotations without truncating journal replay. */
function dropUnusableContextUsage(record: Record<string, unknown>): void {
  const bodies = [
    record.kind === 'item' ? record.body : undefined,
    ...(record.kind === 'lifecycle-batch' && Array.isArray(record.mutations)
      ? record.mutations.map((mutation) => (isPlainObject(mutation) ? mutation.body : undefined))
      : [])
  ]
  for (const body of bodies) {
    if (
      isPlainObject(body) &&
      body.kind === 'turn' &&
      body.contextUsage !== undefined &&
      !isAdmissibleAgentSessionContextUsage(body.contextUsage)
    ) {
      delete body.contextUsage
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
