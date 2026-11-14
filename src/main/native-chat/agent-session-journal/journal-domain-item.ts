import type { JournalDomainItemWrite, JournalDomainItemCommit } from './journal-domain-item-write'
import { capturePRPendingAction } from '../../github/pr-watch/pr-pending-actions'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../../../shared/native-chat/native-chat-pull-request-event'
import { JournalSqlScope } from './journal-sql-scope'
import {
  journalDomainNewestTurn,
  journalDomainUnsettledInputs
} from './journal-domain-input-populations'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type Database from '../../sqlite/sync-database'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
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
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { writeJournalDomainTextSnapshot } from './journal-domain-text-snapshot'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { readJournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'

export type { JournalDomainItemWrite, JournalDomainItemCommit } from './journal-domain-item-write'
/** Runs only on the owning writer connection, inside its command SAVEPOINT. */
export function assertJournalDomainItemAuthority(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  fence: number
) {
  if (!db.isTransaction) {
    throw new Error('journal message requires its writer transaction')
  }
  const head = db
    .prepare(`SELECT last_sequence, highest_fence, context_boundary FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal message targets a retired chat epoch')
  }
  assertJournalFence(fence, Number(head.highest_fence))
  return head
}

export function applyJournalDomainItem(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalDomainItemWrite,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
): JournalDomainItemCommit {
  const { sessionId, epoch } = target
  const prefix = [sessionId, epoch] as const
  const head = assertJournalDomainItemAuthority(db, target, input.options.fence)
  const cursor = { epoch, sequence: Number(head.last_sequence) }
  const empty: JournalDomainItemCommit = {
    cursor,
    publicCursor: { ...cursor, epoch: journalContextEpoch(epoch, Number(head.context_boundary)) },
    outcome: { kind: 'committed', wrote: false },
    items: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  if (input.options.onlyBetweenTurns) {
    const scope = new JournalSqlScope(db, sessionId, epoch)
    if (
      journalDomainNewestTurn(scope)?.state === 'running' ||
      !journalDomainUnsettledInputs(scope, true).next().done
    ) {
      return empty
    }
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
  const blindText =
    input.kind === 'text-snapshot' &&
    (input.body.role === 'assistant' || input.body.role === 'reasoning') &&
    input.body.command === undefined &&
    input.body.blocks.every(
      (block) =>
        block.type === 'text' &&
        typeof block.text === 'string' &&
        (block.presentation === undefined || typeof block.presentation === 'string') &&
        (block.tone === undefined || typeof block.tone === 'string') &&
        block.providerFrame === undefined
    )
  const stored = db
    .prepare(`SELECT revision,sequence,ordinal,owner_fence,execution_owner,hidden,placement_json,
      message_role,lifecycle_state,assistant_prose,
      CASE WHEN ? AND kind='message' AND message_role=? AND subagent_row=0 AND command_entry=0
        THEN NULL ELSE payload_json END AS payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(
      Number(blindText),
      input.body.kind === 'message' ? input.body.role : null,
      ...prefix,
      itemId
    )
  const previous: AgentJournalRenderItem | undefined = stored
    ? stored.payload_json === null
      ? {
          ...JSON.parse(String(stored.placement_json)),
          revision: Number(stored.revision),
          sequence: Number(stored.sequence),
          body: input.body
        }
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
    const related = db
      .prepare(`SELECT json_extract(placement_json,'$.turnScope') AS scope_json
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=COALESCE(
        (SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
      .get(...prefix, ...prefix, key, key)
    if (related) {
      scope =
        related.scope_json === null ? { kind: 'thread' } : JSON.parse(String(related.scope_json))
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
  const next = previous ? journalItemRevisionValue(previous, rendered) : rendered
  const executionOwner =
    row.executionOwner ?? (stored?.execution_owner == null ? null : Number(stored.execution_owner))
  const items =
    blindText &&
    writeJournalDomainTextSnapshot(db, target, stored, next, row.ownerFence!, executionOwner)
      ? [next]
      : writeJournalDomainCurrentItem(db, target, {
          inputObservation: row,
          item: next,
          ...(previous
            ? {
                previous: {
                  item: previous,
                  ordinal: Number(stored!.ordinal),
                  hidden: Boolean(stored!.hidden)
                }
              }
            : {}),
          hidden: Boolean(stored?.hidden),
          writtenSequence: sequence,
          stopSettle,
          ownerFence: row.ownerFence!,
          executionOwner
        })
  if (!input.options.recovered) {
    const storedItem = items.find((item) => item.itemId === itemId)
    if (storedItem) {
      capturePRPendingAction(db, sessionId, storedItem, savedAt, previous?.body)
    }
  }
  const result: JournalDomainItemCommit = {
    cursor: { epoch, sequence },
    publicCursor: { epoch: journalContextEpoch(epoch, Number(head.context_boundary)), sequence },
    outcome: { kind: 'committed', wrote: true },
    insertedItemIds: previous ? [] : [itemId],
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
  Object.assign(result, spendJournalSqlCommandCards(db, prefix, savedAt, [itemId]))
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
    {
      fence: row.fence,
      observedAt:
        row.body.kind === 'status' && row.body.presentation === PULL_REQUEST_EVENT_PRESENTATION
          ? 0
          : row.ts
    }
  )
  return result
}
