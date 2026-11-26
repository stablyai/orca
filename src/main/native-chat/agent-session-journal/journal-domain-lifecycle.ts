import { applyJournalDomainLifecycleDispatches } from './journal-domain-lifecycle-dispatch'
import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import type { JournalWriterPublication } from './journal-writer-changes'
import type { JournalWriterCoordinate } from './journal-writer-effects'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { removeJournalDomainItem, journalDomainEventItem } from './journal-domain-item-removal'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { journalLifecycleMutationItemId } from './writing/journal-lifecycle-mutation'
import {
  partitionJournalLifecycleMutations,
  journalLifecycleMutationFitsOneBatch
} from './writing/journal-lifecycle-batch-partition'
import { assertJournalFence } from './writing/journal-write-guards'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { spendJournalSqlCommandCards } from './journal-sql-message-effects'
import { writeJournalDomainLifecycleItem } from './journal-domain-lifecycle-item'
import { observeJournalDomainInputItem } from './journal-domain-input-ends'

export type JournalDomainLifecycleCommit = JournalWriterPublication & {
  cursor: AgentJournalCursor
  inputChanged: boolean
  coordinates: JournalWriterCoordinate[]
  removedItemIds: string[]
}

export function journalDomainLifecycleCommit(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): JournalDomainLifecycleCommit {
  if (!db.isTransaction) {
    throw new Error('journal lifecycle requires its writer transaction')
  }
  return {
    cursor: journalDomainContextHead(db, target),
    items: [],
    receipts: [],
    cards: [],
    removedItemIds: [],
    inputChanged: false,
    coordinates: []
  }
}

export function hasJournalDomainSettlement(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  settlementId: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM journal_settlements WHERE session_id=? AND epoch=? AND settlement_id=?`
      )
      .get(target.sessionId, target.epoch, settlementId)
  )
}

function recordSettlement(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  settlementId: string
): void {
  const prefix = [target.sessionId, target.epoch] as const
  db.prepare(`INSERT OR IGNORE INTO journal_settlements(session_id,epoch,settlement_id)
    VALUES(?,?,?)`).run(...prefix, settlementId)
}

/** Current dispatches precede the atomic mutation groups, exactly at this writer position. */
export function applyJournalDomainLifecycle(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalLifecycleBatchInput,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
): JournalDomainLifecycleCommit {
  const result = journalDomainLifecycleCommit(db, target)
  if (!input.rejectsQueued && hasJournalDomainSettlement(db, target, input.settlementId)) {
    return result
  }
  if (!applyJournalDomainLifecycleDispatches(db, target, input, savedAt, result)) {
    return result
  }
  if (hasJournalDomainSettlement(db, target, input.settlementId)) {
    return result
  }
  const mutations = input.mutations.map((mutation) =>
    mutation.kind === 'item' && mutation.ownerFence === undefined && input.ownerFence !== undefined
      ? { ...mutation, ownerFence: input.ownerFence }
      : mutation
  )
  const deleted = new Set(result.removedItemIds)
  let named = false
  const planned = new Set<string>()
  for (const chunk of partitionJournalLifecycleMutations(input.settlementId, mutations, {
    ...input,
    epoch: target.epoch
  })) {
    const only = chunk.mutations.length === 1 ? chunk.mutations[0] : undefined
    const oversized =
      only &&
      !journalLifecycleMutationFitsOneBatch(chunk.settlementId, only, {
        ...input,
        epoch: target.epoch
      })
    const id = named ? chunk.settlementId : input.settlementId
    if (!oversized) {
      named = true
    }
    if (!oversized && hasJournalDomainSettlement(db, target, id)) {
      continue
    }
    const sequence = result.cursor.sequence + 1
    const changedItems: JournalWriterPublication['items'] = []
    const inputObservations: ReturnType<
      typeof writeJournalDomainLifecycleItem
    >['inputObservation'][] = []
    const removedItemIds: string[] = []
    const head = db
      .prepare(`SELECT highest_fence FROM journal_chat_state WHERE session_id=? AND epoch=?`)
      .get(target.sessionId, target.epoch)!
    assertJournalFence(input.fence, Number(head.highest_fence))
    for (const [index, mutation] of chunk.mutations.entries()) {
      const rawId = journalLifecycleMutationItemId(mutation)
      const alias = db
        .prepare(
          `SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?`
        )
        .get(target.sessionId, target.epoch, rawId)
      const itemId = alias ? String(alias.item_id) : rawId
      const previous = readJournalDomainDispatchItem(db, target, itemId)
      const tombstone = db
        .prepare(
          `SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?`
        )
        .get(target.sessionId, target.epoch, itemId)
      const repeated = planned.has(itemId)
      planned.add(itemId)
      if (
        oversized &&
        !repeated &&
        (mutation.kind === 'tombstone'
          ? tombstone
          : previous &&
            isDeepStrictEqual(previous.item.body, mutation.body) &&
            (!Object.hasOwn(mutation, 'echoOf') ||
              db
                .prepare(
                  `SELECT 1 FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=? AND echo_declared=1`
                )
                .get(target.sessionId, target.epoch, rawId)) &&
            (mutation.linkage === undefined ||
              isDeepStrictEqual(
                agentJournalLinkageFields(previous.item),
                agentJournalLinkageFields(mutation.linkage)
              )))
      ) {
        continue
      }
      if (mutation.kind === 'tombstone') {
        const removed = removeJournalDomainItem(db, target, rawId, sequence)
        changedItems.splice(
          0,
          changedItems.length,
          ...changedItems.filter((item) => item.itemId !== removed.itemId),
          ...removed.items
        )
        deleted.add(removed.itemId)
        removedItemIds.push(removed.itemId)
      } else {
        const commit = writeJournalDomainLifecycleItem(db, target, mutation, {
          fence: input.fence,
          recovered: input.recovered,
          sequence,
          sequenceIndex: oversized ? 0 : index,
          savedAt,
          stopSettle
        })
        const revived = commit.items[0]!.itemId
        removedItemIds.splice(
          0,
          removedItemIds.length,
          ...removedItemIds.filter((id) => id !== revived)
        )
        deleted.delete(revived)
        result.insertedItemIds ??= []
        result.insertedItemIds.push(...commit.insertedItemIds)
        changedItems.push(...commit.items)
        inputObservations.push(commit.inputObservation)
        result.receipts.push(...commit.receipts)
        result.inputChanged ||= commit.receipts.length > 0
        result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
      }
    }
    if (oversized && changedItems.length === 0 && removedItemIds.length === 0) {
      continue
    }
    const currentItems = new Map(changedItems.map((item) => [item.itemId, item]))
    for (const { item, source } of inputObservations) {
      if (item.itemId === source.itemId && currentItems.get(source.itemId)?.body === item.body) {
        observeJournalDomainInputItem(db, target, item, source)
      }
    }
    const spent = spendJournalSqlCommandCards(
      db,
      [target.sessionId, target.epoch],
      savedAt,
      changedItems.map((item) => item.itemId)
    )
    result.cards.push(...spent.cards)
    result.inputChanged ||= spent.cards.length > 0
    if (spent.editDeadline !== undefined) {
      result.editDeadline = spent.editDeadline
    }
    appendJournalSqlEvent(
      db,
      target,
      sequence,
      savedAt,
      {
        items: changedItems.map(journalDomainEventItem),
        removedItemIds,
        submissions: result.receipts
          .filter((receipt) => receipt.cursor.sequence === sequence)
          .map((receipt) => receipt.clientMessageId),
        cards: spent.cards.map((card) => card.messageId)
      },
      { fence: input.fence, observedAt: savedAt }
    )
    if (!oversized) {
      recordSettlement(db, target, id)
    }
    result.items.push(...changedItems)
    result.removedItemIds.push(...removedItemIds)
    result.cursor = { ...result.cursor, sequence }
    result.coordinates.push({
      kind: oversized ? only!.kind : 'lifecycle-batch',
      epoch: target.epoch,
      seq: sequence
    })
  }
  result.removedItemIds = [...deleted]
  result.items = [...new Map(result.items.map((item) => [item.itemId, item])).values()].filter(
    (item) => !deleted.has(item.itemId)
  )
  return result
}
