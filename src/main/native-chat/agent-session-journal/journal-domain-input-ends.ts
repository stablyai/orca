import type Database from '../../sqlite/sync-database'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalStatusItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readCodexErrorWillRetry } from '../../codex/app-server/codex-structured-thread-facts'
import type { JournalInputEnd } from './input-order/journal-input-obligations'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import type { JournalItemRow, JournalStopEvent } from './durable-rows/journal-row-schema'

type Target = { sessionId: string; epoch: string }
export type JournalDomainInputItemObservation = Pick<
  JournalItemRow,
  'itemId' | 'seq' | 'fence' | 'executionOwner' | 'ownerFence' | 'agentId' | 'turnScope'
>

function* candidates(db: Database.Database, target: Target) {
  let ordinal = -1
  let messageId = ''
  for (;;) {
    const page = db
      .prepare(`SELECT message_id,ordinal,attempt_sequence,payload_json,facts_json,
      admission_body_json IS NOT NULL AS has_source FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND candidate=1
        AND (ordinal,message_id)>(?,?) ORDER BY ordinal,message_id LIMIT 128`)
      .all(target.sessionId, target.epoch, ordinal, messageId)
    for (const row of page) {
      const submission: AgentJournalSubmission = JSON.parse(String(row.payload_json))
      const facts: JournalDomainSubmissionStoredFacts = JSON.parse(String(row.facts_json))
      yield {
        submission,
        facts,
        sourceSequence: row.has_source ? Number(row.attempt_sequence) : undefined
      }
    }
    if (page.length < 128) {
      return
    }
    const last = page.at(-1)!
    ordinal = Number(last.ordinal)
    messageId = String(last.message_id)
  }
}

function observe(
  db: Database.Database,
  target: Target,
  sourceItemKey: string,
  observation: JournalInputEnd
) {
  db.prepare(`INSERT INTO journal_input_end_observations(session_id,epoch,source_item_key,observation_json)
    VALUES(?,?,?,?) ON CONFLICT(session_id,epoch,source_item_key) DO UPDATE SET observation_json=excluded.observation_json`).run(
    target.sessionId,
    target.epoch,
    sourceItemKey,
    JSON.stringify(observation)
  )
}

function ended(db: Database.Database, target: Target, messageId: string) {
  const changed = db
    .prepare(`UPDATE journal_submission_attempts SET facts_json=json_set(facts_json,'$.ended',json('true'))
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1
      AND COALESCE(json_extract(facts_json,'$.ended'),0)=0`)
    .run(target.sessionId, target.epoch, messageId)
  if (changed.changes > 0) {
    invalidateJournalDomainQueue(db, target)
  }
}

function providerAttemptEnded(frame: AgentJournalStatusItem['providerFrame']) {
  if (
    frame?.provider !== 'codex' ||
    frame.kind !== 'notification:error' ||
    frame.payload.truncated
  ) {
    return false
  }
  try {
    return !readCodexErrorWillRetry(JSON.parse(frame.payload.head))
  } catch {
    return false
  }
}

/** Observe only admitted source items, never a placement change or a derived display rewrite. */
export function observeJournalDomainInputItem(
  db: Database.Database,
  target: Target,
  item: AgentJournalRenderItem,
  source: JournalDomainInputItemObservation
): void {
  if (source.agentId) {
    return
  }
  const fence = source.executionOwner ?? source.ownerFence ?? source.fence
  const turn = readAgentJournalTurn(item.body)
  const terminal =
    (turn && turn.state !== 'running' && turn.state !== 'unverifiable') ||
    providerAttemptEnded(item.body.kind === 'status' ? item.body.providerFrame : undefined)
  if (!turn && !terminal) {
    return
  }
  observe(db, target, source.itemId, { kind: 'item', turnId: turn?.turnId ?? null })
  if (!terminal) {
    return
  }
  let latest = 0
  for (const { submission, facts } of candidates(db, target)) {
    if ((facts.handover?.fence ?? facts.admission.fence ?? submission.fence) === fence) {
      latest = Math.max(latest, facts.handover?.sequence ?? submission.submittedSequence ?? 0)
    }
  }
  for (const { submission, facts, sourceSequence } of candidates(db, target)) {
    if (
      facts.ended ||
      (facts.handover?.fence ?? facts.admission.fence ?? submission.fence) !== fence
    ) {
      continue
    }
    const after =
      facts.handover?.sequence ??
      (submission.handoverRecorded ? Infinity : (sourceSequence ?? Infinity))
    const scope = facts.handover?.scope ?? facts.admission.scope
    const matches =
      scope?.kind === 'turn'
        ? scope.turnItemId ===
          (source.turnScope?.kind === 'turn' ? source.turnScope.turnItemId : source.itemId)
        : turn?.userItemId
          ? turn.userItemId === agentJournalSubmissionKey(submission.clientMessageId)
          : after === latest
    if (matches && source.seq > after) {
      ended(db, target, submission.clientMessageId)
    }
  }
}

/** A removed turn's admitted identity remains evidence for a later scoped user Stop. */
export function observeJournalDomainInputStop(
  db: Database.Database,
  target: Target,
  sourceItemKey: string,
  sequence: number,
  fence: number,
  event: JournalStopEvent
): void {
  const prior = db
    .prepare(`SELECT observation_json FROM journal_input_end_observations
    WHERE session_id=? AND epoch=? AND source_item_key=?`)
    .get(target.sessionId, target.epoch, sourceItemKey)
  const previous: JournalInputEnd | null = prior ? JSON.parse(String(prior.observation_json)) : null
  if (previous?.kind === 'stop' && JSON.stringify(previous.event) === JSON.stringify(event)) {
    return
  }
  observe(db, target, sourceItemKey, { kind: 'stop', event })
  for (const { submission, facts } of candidates(db, target)) {
    const handover = facts.handover
    if (
      facts.ended ||
      !handover ||
      handover.fence !== fence ||
      sequence <= handover.sequence ||
      event.reason !== 'user-stop'
    ) {
      continue
    }
    const scope = handover.scope
    let turnId: string | null | undefined
    if (scope?.kind === 'turn') {
      const row = db
        .prepare(`SELECT observation_json FROM journal_input_end_observations
        WHERE session_id=? AND epoch=? AND source_item_key=?`)
        .get(target.sessionId, target.epoch, scope.turnItemId)
      const end: JournalInputEnd | null = row ? JSON.parse(String(row.observation_json)) : null
      if (end?.kind === 'item') {
        turnId = end.turnId
      } else {
        const current = db
          .prepare(`SELECT payload_json FROM journal_items
          WHERE session_id=? AND epoch=? AND item_id=?`)
          .get(target.sessionId, target.epoch, scope.turnItemId)
        const item: AgentJournalRenderItem | null = current
          ? JSON.parse(String(current.payload_json))
          : null
        turnId = readAgentJournalTurn(item?.body)?.turnId
      }
    }
    if (!event.turnId || turnId === event.turnId) {
      ended(db, target, submission.clientMessageId)
    }
  }
}

/** The accepted native item's observed placement is historical, and removal cannot lower it. */
export function refreshJournalDomainAcceptedHandover(
  db: Database.Database,
  target: Target,
  itemId: string
): void {
  const item = db
    .prepare(`SELECT item.sequence FROM journal_submission_attempts attempt
    JOIN journal_items item ON item.session_id=attempt.session_id AND item.epoch=attempt.epoch AND item.item_id=attempt.item_id
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.item_id=? AND attempt.current=1 AND attempt.dispatch_state='accepted'`)
    .get(target.sessionId, target.epoch, itemId)
  if (item) {
    const changed = db
      .prepare(`UPDATE journal_chat_state SET accepted_handover_sequence=?
    WHERE session_id=? AND epoch=? AND accepted_handover_sequence<?`)
      .run(item.sequence, target.sessionId, target.epoch, item.sequence)
    if (changed.changes > 0) {
      invalidateJournalDomainQueue(db, target)
    }
  }
}
