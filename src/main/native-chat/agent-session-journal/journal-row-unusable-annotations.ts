// Annotations on a persisted row this build cannot use, removed from a row it still keeps, before
// the row's content is checked (journal-row-schema.ts).

import { isAdmissibleAgentSessionContextUsage } from '../../../shared/agent-session-context-usage-schema'

export function dropUnusableRowAnnotations(record: Record<string, unknown>): void {
  dropUnusableProducerLinkage(record)
  dropUnusableTurnScope(record)
  if (record.kind === 'lifecycle-batch' && Array.isArray(record.mutations)) {
    for (const mutation of record.mutations) {
      if (isPlainObject(mutation)) {
        dropUnusableProducerLinkage(mutation)
        dropUnusableTurnScope(mutation)
      }
    }
  }
  dropUnusableContextUsage(record)
}

/** Linkage ids this build cannot trust, removed from a row it still keeps.
 *
 *  Deliberately NOT part of `isJournalRow`: rejecting a row there drops it from
 *  the timeline, so a validator tightened against one bad field becomes a
 *  whole-store kill switch. Dropping the field degrades the row to the
 *  session's own agent — what every row said before linkage existed — while
 *  keeping the content, which is always the safer direction. An `agentId` that
 *  survives is a real one: the reader scopes on PRESENCE, so `''` or a
 *  non-string left in place would hide the row from its own author for good. */
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

/** A scope this build cannot place, removed like unusable linkage: the row then reads as one
 *  written before scopes existed, and the reducer derives its scope. */
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

/** Context facts this build cannot read, removed from the turn row that carries
 *  them. Same reasoning as linkage: they are an annotation on the turn, and
 *  rejecting the row for them would truncate the journal from that row on. */
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
