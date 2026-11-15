import { capturePRPendingAction } from '../../github/pr-watch/pr-pending-actions'
import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalLifecycleMutationInput } from './writing/journal-lifecycle-mutation'
import { journalLifecycleMutationItemId } from './writing/journal-lifecycle-mutation'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { isProviderUserMessageEcho } from './projection/journal-item-echo'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import { journalRenderItem } from './projection/journal-render-item'
import { journalRowBase } from './writing/journal-row-builders'
import {
  matchJournalSqlMessageEcho,
  acceptJournalSqlMessageEcho
} from './journal-sql-message-effects'
import { readJournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'
import { isJournalProviderActivity } from './projection/journal-provider-activity'
import type { JournalItemRow } from './durable-rows/journal-row-schema'

/** A lifecycle group owns its one event; each current row retains ordinary revision/echo semantics. */
export function writeJournalDomainLifecycleItem(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  mutation: Extract<JournalLifecycleMutationInput, { kind: 'item' }>,
  position: {
    fence: number
    recovered?: true
    sequence: number
    sequenceIndex: number
    savedAt: number
    stopSettle?: JournalStopSettleFact
  }
) {
  const prefix = [target.sessionId, target.epoch] as const
  const rawId = journalLifecycleMutationItemId(mutation)
  const alias = db
    .prepare(
      `SELECT item_id,echo_declared FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?`
    )
    .get(...prefix, rawId)
  const declaration = Boolean(alias?.echo_declared) || Object.hasOwn(mutation, 'echoOf')
  let itemId = alias ? String(alias.item_id) : rawId
  let echo: AgentJournalSubmission | undefined
  if (
    !alias &&
    !declaration &&
    mutation.body.kind === 'message' &&
    isProviderUserMessageEcho(rawId, mutation.body)
  ) {
    const head = db
      .prepare(`SELECT context_boundary FROM journal_chat_state WHERE session_id=? AND epoch=?`)
      .get(...prefix)!
    echo = matchJournalSqlMessageEcho(db, prefix, mutation.body, Number(head.context_boundary))
    if (echo) {
      itemId = agentJournalSubmissionKey(echo.clientMessageId)
    }
  }
  const previous = readJournalDomainDispatchItem(db, target, itemId)
  const tombstone = db
    .prepare(
      `SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?`
    )
    .get(...prefix, itemId)
  const revision = Math.max(previous?.item.revision ?? 0, Number(tombstone?.revision ?? 0)) + 1
  const row: JournalItemRow = {
    kind: 'item',
    itemId: rawId,
    revision,
    body: mutation.body,
    ...journalRowBase(
      target.epoch,
      position.sequence,
      position.fence,
      mutation.observedAt ?? position.savedAt
    ),
    ...(position.recovered ? { recovered: true } : {}),
    ownerFence: previous?.ownerFence ?? mutation.ownerFence ?? position.fence,
    turnScope: mutation.turnScope
  }
  const rendered = journalRenderItem(
    itemId,
    revision,
    mutation.body,
    row,
    mutation.turnScope,
    mutation.linkage,
    position.sequenceIndex
  )
  const items = writeJournalDomainCurrentItem(db, target, {
    item: previous ? journalItemRevisionValue(previous.item, rendered) : rendered,
    ...(previous ? { previous } : {}),
    hidden: previous?.hidden ?? false,
    ownerFence: row.ownerFence!,
    executionOwner: previous?.executionOwner,
    writtenSequence: position.sequence,
    stopSettle: position.stopSettle
  })
  if (!position.recovered) {
    const storedItem = items.find((item) => item.itemId === itemId)
    if (storedItem) {
      capturePRPendingAction(
        db,
        target.sessionId,
        storedItem,
        position.savedAt,
        previous?.item.body
      )
    }
  }
  if (tombstone) {
    db.prepare(
      `DELETE FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?`
    ).run(...prefix, itemId)
  }
  if ((!alias && itemId !== rawId) || (!alias?.echo_declared && declaration)) {
    db.prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id,echo_declared,echo_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id,epoch,provider_item_id) DO UPDATE SET echo_declared=excluded.echo_declared,echo_json=excluded.echo_json`).run(
      ...prefix,
      rawId,
      itemId,
      Number(declaration),
      declaration ? JSON.stringify(mutation.echoOf ?? null) : null
    )
  }
  const receipt =
    !declaration && itemId !== rawId
      ? acceptJournalSqlMessageEcho(db, prefix, rawId, itemId, row, echo)
      : undefined
  if (isJournalProviderActivity(row.recovered, rawId, row.body)) {
    db.prepare(`INSERT INTO journal_provider_activity(session_id,epoch,fence,last_activity_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id,epoch,fence) DO UPDATE SET last_activity_at=MAX(last_activity_at,excluded.last_activity_at)`).run(
      ...prefix,
      previous?.executionOwner ?? row.ownerFence!,
      position.savedAt
    )
  }
  return {
    insertedItemIds: previous ? [] : [itemId],
    items,
    inputObservation: { item: items[0]!, source: { ...row, ...mutation.linkage } },
    receipts: receipt ? [receipt] : [],
    ...(receipt ? { acceptedInputs: readJournalSqlAcceptedInputs(db, prefix) } : {})
  }
}
