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
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import { isProviderUserMessageEcho } from './projection/journal-item-echo'
import { isJournalProviderActivity } from './projection/journal-provider-activity'
import {
  acceptJournalSqlMessageEcho,
  spendJournalSqlCommandCards
} from './journal-sql-message-effects'
import { journalRenderItem } from './projection/journal-render-item'
import { resolveJournalGuardedItem } from './writing/journal-timeline-resolution'
import { journalRowBase } from './writing/journal-row-builders'
import { assertJournalFence } from './writing/journal-write-guards'
import type { JournalItemRow } from './durable-rows/journal-row-schema'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { journalDomainStopNote, refreshJournalDomainStopNotes } from './journal-domain-stop-notes'
import {
  readJournalSqlAcceptedInputs,
  type JournalSqlAcceptedInputs
} from './journal-sql-accepted-inputs'

type JournalDomainItemFields = {
  identity: AgentJournalItemIdentity
  options: JournalItemAppendOptions
  scopeItemIds?: readonly string[]
}

export type JournalDomainItemWrite = JournalDomainItemFields &
  (
    | { kind: 'item'; body: AgentJournalItemBody }
    | { kind: 'text-snapshot'; body: AgentJournalMessageItem }
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
    const fingerprint = agentSessionSendBodyFingerprint(sessionId, input.body)
    const candidates = db
      .prepare(`SELECT attempt.payload_json FROM journal_submission_attempts AS attempt
      JOIN journal_items AS item ON item.session_id=attempt.session_id AND item.epoch=attempt.epoch AND item.item_id=attempt.item_id
      WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1 AND attempt.fingerprint=?
        AND attempt.dispatch_state<>'rejected'
        AND (?=0 OR COALESCE(attempt.accepted_sequence,0)>?)
        AND NOT EXISTS(SELECT 1 FROM journal_item_aliases AS alias WHERE alias.session_id=attempt.session_id
          AND alias.epoch=attempt.epoch AND alias.item_id=attempt.item_id AND alias.provider_item_id<>alias.item_id)
      ORDER BY attempt.submitted_at, attempt.ordinal`)
      .iterate(...prefix, fingerprint, head.context_boundary, head.context_boundary)
    for (const candidate of candidates) {
      const submission: AgentJournalSubmission = JSON.parse(String(candidate.payload_json))
      if (!isWriteFailureSubmission(submission)) {
        echo = submission
        itemId = agentJournalSubmissionKey(submission.clientMessageId)
        break
      }
    }
  }
  const stored = db
    .prepare(`SELECT revision, ordinal, owner_fence, execution_owner, hidden, payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, itemId)
  const previous: AgentJournalRenderItem | undefined = stored
    ? JSON.parse(String(stored.payload_json))
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
  const stopNote = journalDomainStopNote(
    previous ? journalItemRevisionValue(previous, rendered) : rendered,
    (id) => item(id) ?? undefined
  )
  const next = stopNote.item
  const result: JournalDomainItemCommit = {
    cursor: { epoch, sequence },
    outcome: { kind: 'committed', wrote: true },
    items: [next],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  const payload = JSON.stringify(next)
  const metadata = journalDomainHistoryMetadata(next, payload)
  db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,execution_owner,payload_json,
      root,subagent_row,subagent_group_key,turn_marker,wire_bytes,turn_item_id,original_stop_note_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET
      revision=excluded.revision, sequence=excluded.sequence, sequence_index=excluded.sequence_index,
      execution_owner=excluded.execution_owner, payload_json=excluded.payload_json,
      root=excluded.root, subagent_row=excluded.subagent_row, subagent_group_key=excluded.subagent_group_key,
      turn_marker=excluded.turn_marker, wire_bytes=excluded.wire_bytes,
      turn_item_id=excluded.turn_item_id, original_stop_note_json=excluded.original_stop_note_json`).run(
    ...prefix,
    itemId,
    stored?.ordinal ?? sequence,
    revision,
    next.sequence,
    next.sequenceIndex ?? 0,
    row.ownerFence!,
    row.executionOwner ?? stored?.execution_owner ?? null,
    payload,
    metadata.root,
    metadata.subagentRow,
    metadata.subagentGroupKey,
    metadata.turnMarker,
    metadata.wireBytes,
    stopNote.turnItemId,
    stopNote.originalStopNoteJson
  )
  writeJournalDomainItemNames(
    db,
    target,
    next,
    { ordinal: Number(stored?.ordinal ?? sequence), hidden: Boolean(stored?.hidden) },
    metadata.namedSubagentIds,
    previous
      ? { item: previous, ordinal: Number(stored!.ordinal), hidden: Boolean(stored!.hidden) }
      : undefined
  )
  db.prepare(
    'DELETE FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(...prefix, itemId)
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
  if (readAgentJournalTurn(next.body) || readAgentJournalTurn(previous?.body)) {
    result.items.push(...refreshJournalDomainStopNotes(db, target, [itemId]))
  }
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
