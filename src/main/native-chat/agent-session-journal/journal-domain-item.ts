import type Database from '../../sqlite/sync-database'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import { isProviderUserMessageEcho } from './projection/journal-item-echo'
import { isJournalProviderActivity } from './projection/journal-provider-activity'
import {
  acceptJournalSqlMessageEcho,
  matchJournalSqlMessageEcho,
  spendJournalSqlCommandCards
} from './journal-sql-message-effects'
import { journalRenderItem } from './projection/journal-render-item'
import { resolveJournalGuardedItem } from './writing/journal-timeline-resolution'
import { journalRowBase } from './writing/journal-row-builders'
import { assertJournalFence } from './writing/journal-write-guards'
import type { JournalItemRow } from './durable-rows/journal-row-schema'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import {
  readJournalSqlAcceptedInputs,
  type JournalSqlAcceptedInputs
} from './journal-sql-accepted-inputs'
import type { JournalTextSnapshotPosition } from './writing/journal-text-snapshot-position'

type JournalDomainItemFields = {
  identity: AgentJournalItemIdentity
  options: JournalItemAppendOptions
  scopeItemIds?: readonly string[]
}

export type JournalDomainItemWrite = JournalDomainItemFields &
  (
    | { kind: 'item'; body: AgentJournalItemBody }
    | {
        kind: 'text-snapshot'
        body: AgentJournalMessageItem
        position?: JournalTextSnapshotPosition
      }
  )

export type JournalDomainItemCommit = {
  cursor: AgentJournalCursor
  outcome:
    | { kind: 'committed'; wrote: boolean }
    | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }
  items: AgentJournalRenderItem[]
  receipts: AgentJournalAcceptanceReceipt[]
  cards: QueuedMessageRow[]
  inputChanged: boolean
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
}

/** Runs only on the owning writer connection, inside its command SAVEPOINT. */
export function applyJournalDomainItem(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalDomainItemWrite,
  savedAt: number
): JournalDomainItemCommit {
  if (!db.isTransaction) {
    throw new Error('journal message requires its writer transaction')
  }
  const { sessionId, epoch } = target
  const prefix = [sessionId, epoch] as const
  const head = db
    .prepare(`SELECT last_sequence, highest_fence, context_boundary FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(...prefix)
  if (!head) {
    throw new Error('journal message targets a retired chat epoch')
  }
  assertJournalFence(input.options.fence, Number(head.highest_fence))
  const cursor = { epoch, sequence: Number(head.last_sequence) }
  const empty: JournalDomainItemCommit = {
    cursor,
    outcome: { kind: 'committed', wrote: false },
    items: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  const rawId = agentJournalItemKey(input.identity)
  const alias = db
    .prepare(`SELECT item_id, echo_declared FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
    .get(...prefix, rawId)
  let itemId = alias ? String(alias.item_id) : rawId
  let echo: AgentJournalSubmission | undefined
  const declaration = Boolean(alias?.echo_declared) || Object.hasOwn(input.options, 'echoOf')
  if (
    !alias &&
    !declaration &&
    input.body.kind === 'message' &&
    isProviderUserMessageEcho(rawId, input.body)
  ) {
    echo = matchJournalSqlMessageEcho(db, prefix, input.body, Number(head.context_boundary))
    if (echo) {
      itemId = agentJournalSubmissionKey(echo.clientMessageId)
    }
  }
  const position =
    input.kind === 'text-snapshot' &&
    input.position?.itemId === itemId &&
    (input.body.role === 'assistant' || input.body.role === 'reasoning') &&
    input.body.blocks.every((block) => block.type === 'text')
      ? input.position
      : undefined
  const stored = db
    .prepare(`SELECT revision, ordinal, owner_fence, execution_owner, hidden,
      CASE WHEN revision=? THEN NULL ELSE payload_json END AS payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(position?.revision ?? -1, ...prefix, itemId)
  const previous: AgentJournalRenderItem | undefined = stored
    ? stored.payload_json === null && position
      ? { ...position, body: input.body }
      : JSON.parse(String(stored.payload_json))
    : undefined
  const item = (key: string): AgentJournalRenderItem | null => {
    if (key === rawId || key === itemId) {
      return previous ?? null
    }
    const row = db
      .prepare(`SELECT item.payload_json FROM journal_items AS item
      WHERE item.session_id=? AND item.epoch=? AND item.item_id=COALESCE(
        (SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
      .get(...prefix, ...prefix, key, key)
    return row ? JSON.parse(String(row.payload_json)) : null
  }
  let scope = input.options.turnScope ?? { kind: 'thread' as const }
  for (const key of input.scopeItemIds ?? []) {
    const related = item(key)
    if (related) {
      scope = related.turnScope ?? { kind: 'thread' }
      break
    }
  }
  if (input.kind === 'text-snapshot') {
    const resolved = resolveJournalGuardedItem(
      { item, itemBody: (key) => item(key)?.body ?? null },
      { kind: 'text-snapshot', identity: input.identity, body: input.body },
      scope
    )
    if (resolved.kind === 'dropped' && 'reason' in resolved && resolved.reason === 'turn-settled') {
      return { ...empty, outcome: resolved }
    }
  }
  const tombstone = db
    .prepare(
      `SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?`
    )
    .get(...prefix, itemId)
  const revision = Math.max(previous?.revision ?? 0, Number(tombstone?.revision ?? 0)) + 1
  const sequence = cursor.sequence + 1
  const row: JournalItemRow = {
    kind: 'item',
    itemId: rawId,
    revision,
    body: input.body,
    ...journalRowBase(epoch, sequence, input.options.fence, input.options.observedAt ?? savedAt),
    ownerFence: Number(stored?.owner_fence ?? input.options.ownerFence ?? input.options.fence),
    ...(input.options.executionOwner === undefined
      ? {}
      : { executionOwner: input.options.executionOwner }),
    ...(input.options.recovered ? { recovered: true } : {}),
    turnScope: scope,
    ...agentJournalLinkageFields(input.options)
  }
  const rendered = journalRenderItem(itemId, revision, row.body, row, scope)
  const items = writeJournalDomainCurrentItem(db, target, {
    item: previous ? journalItemRevisionValue(previous, rendered) : rendered,
    ...(previous
      ? {
          previous: {
            item: previous,
            ordinal: Number(stored!.ordinal),
            hidden: Boolean(stored!.hidden)
          }
        }
      : {}),
    ordinal: Number(stored?.ordinal ?? sequence),
    hidden: Boolean(stored?.hidden),
    ownerFence: row.ownerFence!,
    executionOwner:
      row.executionOwner ??
      (stored?.execution_owner == null ? null : Number(stored.execution_owner))
  })
  const result: JournalDomainItemCommit = {
    cursor: { epoch, sequence },
    outcome: { kind: 'committed', wrote: true },
    items,
    receipts: [],
    cards: [],
    inputChanged: false
  }
  if (tombstone) {
    db.prepare(
      'DELETE FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
    ).run(...prefix, itemId)
  }
  if ((!alias && itemId !== rawId) || (!alias?.echo_declared && declaration)) {
    db.prepare(
      `INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id,echo_declared,echo_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,epoch,provider_item_id) DO UPDATE SET echo_declared=excluded.echo_declared,echo_json=excluded.echo_json`
    ).run(
      ...prefix,
      rawId,
      itemId,
      Number(declaration),
      declaration ? JSON.stringify(input.options.echoOf ?? null) : null
    )
  }
  if (!declaration && itemId !== rawId) {
    const receipt = acceptJournalSqlMessageEcho(db, prefix, rawId, itemId, row, echo)
    if (receipt) {
      result.receipts.push(receipt)
      result.inputChanged = true
      result.acceptedInputs = readJournalSqlAcceptedInputs(db, prefix)
    }
  }
  Object.assign(result, spendJournalSqlCommandCards(db, prefix, savedAt))
  result.inputChanged ||= result.cards.length > 0
  if (isJournalProviderActivity(row.recovered, rawId, row.body)) {
    db.prepare(`INSERT INTO journal_provider_activity(session_id,epoch,fence,last_activity_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id,epoch,fence) DO UPDATE SET last_activity_at=MAX(last_activity_at,excluded.last_activity_at)`).run(
      ...prefix,
      row.executionOwner ?? stored?.execution_owner ?? row.ownerFence!,
      savedAt
    )
  }
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    {
      items: result.items.map((item) => ({
        itemId: item.itemId,
        revision: item.revision,
        sequence: item.sequence,
        sequenceIndex: item.sequenceIndex ?? 0
      })),
      submissions: result.receipts.map((receipt) => receipt.clientMessageId),
      cards: result.cards.map((card) => card.messageId)
    },
    { fence: row.fence, observedAt: row.ts }
  )
  return result
}
