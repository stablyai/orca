import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import type { JournalSqlMessage } from './journal-sql-message-commit'
import type Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalWriterCommand } from './journal-writer-command'
import { journalSqlFailure } from './journal-sql-failure'
import type {
  JournalStepsResult,
  JournalStepOutcome,
  JournalWriterStep
} from './writing/journal-writer-step'
import { resolveJournalTimelineItem } from './writing/journal-timeline-resolution'
import { resolveProviderTimelineSettlement } from '../agent-session-timeline/provider-timeline-writer-resolution'
import { applyJournalDomainItem } from './journal-domain-item'
import { journalDomainTimelineReads } from './journal-domain-timeline-reads'
import {
  applyJournalDomainLifecycle,
  hasJournalDomainSettlement,
  journalDomainLifecycleCommit,
  type JournalDomainLifecycleCommit
} from './journal-domain-lifecycle'
import { journalLifecycleMutationItemId } from './writing/journal-lifecycle-mutation'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { applyJournalDomainLifecycleOperation } from './journal-domain-taken-stop'

export type JournalDomainStepsCommit = JournalDomainLifecycleCommit & { value: JournalStepsResult }

/** Each successful step survives a later failure; failed-step payloads and effects never escape. */
export function runJournalSqlSteps(
  db: Database.Database,
  command: JournalWriterCommand & { operation: { kind: 'steps' } },
  savedAt: number
): JournalDomainStepsCommit {
  if (command.effects) {
    throw new Error('journal step commands carry no host receipt')
  }
  const result: JournalDomainStepsCommit = {
    ...journalDomainLifecycleCommit(db, command.target),
    value: { outcomes: [] },
    invalidatedItemIds: []
  }
  const { steps, dropped } = command.operation
  if (dropped) {
    result.value.outcomes = steps.map(() => ({ kind: 'dropped' }))
    return result
  }
  const deleted = new Set<string>()
  for (const step of steps) {
    const restoreRequestEvents = checkpointJournalRequestEvents(db)
    db.exec('SAVEPOINT journal_step')
    try {
      const { commit, outcome } = writeStep(db, command, step, savedAt)
      db.exec('RELEASE journal_step')
      if (commit) {
        result.cursor = commit.cursor
        result.items.push(...commit.items)
        result.insertedItemIds ??= []
        result.insertedItemIds.push(...(commit.insertedItemIds ?? []))
        result.receipts.push(...commit.receipts)
        result.cards.push(...commit.cards)
        for (const item of commit.items) {
          deleted.delete(item.itemId)
        }
        for (const id of commit.removedItemIds) {
          deleted.add(id)
        }
        result.coordinates.push(...commit.coordinates)
        result.inputChanged ||= commit.inputChanged
        if (commit.promptDispatches?.length) {
          result.promptDispatches ??= []
          result.promptDispatches.push(...commit.promptDispatches)
        }
        result.invalidatedItemIds!.push(
          ...(commit.invalidatedItemIds ?? [
            ...commit.items.map((item) => item.itemId),
            ...commit.removedItemIds
          ])
        )
        result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
        if (commit.editDeadline !== undefined) {
          result.editDeadline = commit.editDeadline
        }
      }
      result.value.outcomes.push(outcome)
    } catch (error) {
      db.exec('ROLLBACK TO journal_step; RELEASE journal_step')
      restoreRequestEvents()
      result.value.failure = journalSqlFailure(error)
      break
    }
  }
  result.removedItemIds = [...deleted]
  result.items = [...new Map(result.items.map((item) => [item.itemId, item])).values()].filter(
    (item) => !deleted.has(item.itemId)
  )
  result.value.cursor = result.cursor
  result.value.items = result.items
  return result
}

function writeStep(
  db: Database.Database,
  command: JournalWriterCommand,
  step: JournalWriterStep,
  savedAt: number
): { commit?: JournalDomainLifecycleCommit; outcome: JournalStepOutcome } {
  const { target } = command
  if (step.kind === 'lifecycle') {
    if (Buffer.byteLength(JSON.stringify(step.input), 'utf8') + 512 > step.reservedBytes) {
      throw new Error('structured agent-session transition step exceeded its reserved size')
    }
    const commit = applyJournalDomainLifecycleOperation(
      db,
      target,
      { kind: 'lifecycle', input: step.input },
      savedAt,
      command.facts?.stopSettle
    )
    return { commit, outcome: { kind: 'committed', wrote: commit.coordinates.length > 0 } }
  }
  const view = journalDomainTimelineReads(
    db,
    target,
    command.facts?.stopSettle,
    step.kind === 'settlement' ? undefined : step.options.fence
  )
  if (step.kind === 'settlement') {
    if (hasJournalDomainSettlement(db, target, step.settlementId)) {
      return { outcome: { kind: 'committed', wrote: false } }
    }
    const resolution = step.resolution
    let mutations
    if (resolution.kind === 'history-catch-up') {
      const cursor = journalDomainContextHead(db, target)
      if (
        Atomics.load(resolution.permit, 0) !== 1 ||
        Date.now() >= resolution.deadline ||
        target.epoch !== resolution.expectedCursor.epoch ||
        cursor.sequence !== resolution.expectedCursor.sequence
      ) {
        return { outcome: { kind: 'dropped' } }
      }
      const bytes =
        Buffer.byteLength(
          JSON.stringify({
            settlementId: step.settlementId,
            mutations: resolution.mutations,
            ...(resolution.expectedItems.length ? { expectedItems: resolution.expectedItems } : {})
          }),
          'utf8'
        ) + 512
      if (bytes > step.reservedBytes) {
        throw new Error('structured agent-session transition step exceeded its reserved size')
      }
      const verified = new Set<string>()
      for (const expected of resolution.expectedItems) {
        const current = view.item(expected.key)
        const canonical = canonicalItemId(db, target, expected.key)
        if (
          verified.has(expected.key) ||
          canonical !== expected.canonicalItemId ||
          current?.revision !== expected.revision
        ) {
          return { outcome: { kind: 'dropped' } }
        }
        verified.add(expected.key)
      }
      const seen = new Set<string>()
      for (const mutation of resolution.mutations) {
        const key = agentJournalItemKey(mutation.identity)
        const canonical = canonicalItemId(db, target, key)
        if (seen.has(canonical) || (!verified.has(key) && view.item(canonical))) {
          return { outcome: { kind: 'dropped' } }
        }
        seen.add(canonical)
      }
      mutations = resolution.mutations
    } else {
      mutations = resolveProviderTimelineSettlement(view, resolution)
      const seen = new Set<string>()
      for (const mutation of mutations) {
        const canonical = canonicalItemId(db, target, journalLifecycleMutationItemId(mutation))
        if (seen.has(canonical)) {
          throw new Error('journal_resolved_lifecycle_batch_names_item_twice')
        }
        seen.add(canonical)
      }
    }
    const commit = applyJournalDomainLifecycle(
      db,
      target,
      {
        settlementId: step.settlementId,
        fence: step.fence,
        ownerFence: step.ownerFence,
        recovered: step.recovered,
        mutations
      },
      savedAt,
      command.facts?.stopSettle
    )
    return { commit, outcome: { kind: 'committed', wrote: commit.coordinates.length > 0 } }
  }
  let identity
  let body
  let options = step.options
  let stopped: true | undefined
  if (step.kind === 'creation-fact') {
    const key = agentJournalItemKey(step.identity)
    if (
      step.epoch !== target.epoch ||
      view.item(key) ||
      db
        .prepare(
          `SELECT 1 FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?`
        )
        .get(target.sessionId, target.epoch, key)
    ) {
      return { outcome: { kind: 'dropped' } }
    }
    identity = step.identity
    body = step.body
  } else if (step.kind === 'resolved-item') {
    const resolved = resolveJournalTimelineItem(
      view,
      step.resolution,
      step.options.turnScope,
      step.reservedBytes
    )
    if (resolved.kind === 'dropped') {
      return { outcome: resolved }
    }
    identity = resolved.item.identity
    body = resolved.item.body
    options = { ...options, turnScope: resolved.item.turnScope ?? options.turnScope }
    stopped = resolved.stopped
  } else {
    identity = step.identity
    body = step.body
  }
  if (Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') + 512 > step.reservedBytes) {
    throw new Error('structured agent-session transition step exceeded its reserved size')
  }
  const written = applyJournalDomainItem(
    db,
    target,
    { kind: 'item', identity, body, options },
    savedAt,
    command.facts?.stopSettle
  )
  const snapshot = step.kind === 'resolved-item' && step.resolution.kind === 'text-snapshot'
  const commit: JournalDomainLifecycleCommit = {
    ...written,
    ...(snapshot ? { invalidatedItemIds: [] } : {}),
    removedItemIds: [],
    coordinates:
      written.outcome.kind === 'committed' && written.outcome.wrote
        ? [{ kind: 'item', epoch: target.epoch, seq: written.cursor.sequence }]
        : []
  }
  return { commit, outcome: { ...written.outcome, ...(stopped ? { stopped } : {}) } }
}

function canonicalItemId(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  key: string
): string {
  const alias = db
    .prepare(
      `SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?`
    )
    .get(target.sessionId, target.epoch, key)
  return alias ? String(alias.item_id) : key
}

export function journalSqlTextSteps(
  steps: Extract<JournalWriterCommand['operation'], { kind: 'steps' }>['steps']
): JournalSqlMessage[] | null {
  if (steps.length === 0) {
    return null
  }
  const messages: JournalSqlMessage[] = []
  for (const step of steps) {
    if (step.kind !== 'resolved-item' || step.resolution.kind !== 'text-snapshot') {
      return null
    }
    messages.push({ ...step.resolution, options: step.options })
  }
  return messages
}
