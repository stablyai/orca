import type { JournalForkStageOperation } from './journal-fork-stages'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { journalDomainNamedSubagentIds } from './journal-domain-history-metadata'
import {
  prepareJournalDomainItemRow,
  insertJournalDomainItemRows
} from './journal-domain-import-rows'
import { JournalDerivedTurnScope } from './projection/journal-derived-turn-scope'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from '../agent-session-attachments/agent-session-attachment-references'
import {
  journalDomainQueueFailure,
  refreshJournalDomainQueueFailureReports
} from './journal-domain-queue-failures'
import { journalDomainStopNote } from './journal-domain-stop-notes'

import type { Stage } from './journal-fork-stage-state'

export function applyJournalForkStagePage(
  db: Database.Database,
  stateDirectory: string,
  stage: Stage,
  operation: Extract<JournalForkStageOperation, { kind: 'fork-stage-page' }>,
  now: number
) {
  const next: Stage = {
    ...stage,
    ...(stage.auxiliary ? { auxiliary: { ...stage.auxiliary } } : {})
  }
  const start = performance.now()
  let units = 0
  let bytes = 0
  let accepted = 0
  const budget = () =>
    units < 64 && bytes < 1024 * 1024 && (units === 0 || performance.now() - start < 8)
  while (budget()) {
    if (next.auxiliary) {
      const aux = next.auxiliary
      if (aux.oldName < aux.oldNames.length) {
        const id = aux.oldNames[aux.oldName]!
        const size = Buffer.byteLength(id) + Buffer.byteLength(aux.item.itemId) + 64
        if (units && bytes + size > 1024 * 1024) {
          break
        }
        db.prepare(
          'DELETE FROM journal_item_subagent_names WHERE session_id=? AND epoch=? AND subagent_id=? AND item_id=?'
        ).run(stage.target.sessionId, stage.epoch, id, aux.item.itemId)
        aux.oldName++
        units++
        bytes += size
        continue
      }
      if (aux.name < aux.names.length) {
        const id = aux.names[aux.name]!
        const size = Buffer.byteLength(id) + Buffer.byteLength(aux.item.itemId) + 64
        if (units && bytes + size > 1024 * 1024) {
          break
        }
        db.prepare(
          `INSERT OR IGNORE INTO journal_item_subagent_names(session_id,epoch,subagent_id,item_id,sequence,sequence_index,ordinal,hidden) VALUES(?,?,?,?,?,?,?,0)`
        ).run(
          stage.target.sessionId,
          stage.epoch,
          id,
          aux.item.itemId,
          aux.item.sequence,
          aux.item.sequenceIndex ?? 0,
          aux.ordinal
        )
        aux.name++
        units++
        bytes += size
        continue
      }
      if (aux.claim < aux.claims.length) {
        const upload = aux.claims[aux.claim]!
        const size = Buffer.byteLength(upload) + Buffer.byteLength(stage.target.sessionId) + 16
        if (units && bytes + size > 1024 * 1024) {
          break
        }
        db.prepare(
          'INSERT OR IGNORE INTO agent_session_attachment_claims(upload_id,session_id,claimed_at) VALUES(?,?,?)'
        ).run(upload, stage.target.sessionId, now)
        aux.claim++
        units++
        bytes += size
        continue
      }
      delete next.auxiliary
    }
    const input = operation.items[accepted]
    if (!input) {
      break
    }
    const itemId = agentJournalItemKey(input.identity)
    const stored = db
      .prepare(
        'SELECT ordinal,payload_json,queue_failure_report_turn_item_id FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
      )
      .get(stage.target.sessionId, stage.epoch, itemId)
    const previous: AgentJournalRenderItem | undefined =
      stored && JSON.parse(String(stored.payload_json))
    const scope = JournalDerivedTurnScope.restore(next.derived)
    const rendered: AgentJournalRenderItem = {
      itemId,
      revision: (previous?.revision ?? 0) + 1,
      sequence: next.count + 2,
      body: input.body,
      observedAt: input.observedAt ?? now,
      turnScope: input.turnScope ?? scope.scopeFor(input.body),
      ...agentJournalLinkageFields(input)
    }
    scope.observe(itemId, isRootAgentJournalItem(input), previous?.body, input.body)
    const item = previous ? journalItemRevisionValue(previous, rendered) : rendered
    const prepared = prepareJournalDomainItemRow(item)
    const size = prepared.bytes + Buffer.byteLength(JSON.stringify(input)) + 256
    if (units && bytes + size > 1024 * 1024) {
      break
    }
    const ordinal = stored ? Number(stored.ordinal) : next.count + 1
    const stageTarget = { sessionId: stage.target.sessionId, epoch: stage.epoch }
    const failure = journalDomainQueueFailure(db, stageTarget, item, previous, rendered.sequence)
    const note = journalDomainStopNote(item, (id) => {
      const saved = db
        .prepare(
          'SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
        )
        .get(stageTarget.sessionId, stageTarget.epoch, id)
      return saved ? JSON.parse(String(saved.payload_json)) : undefined
    })
    const names = insertJournalDomainItemRows(
      db,
      { sessionId: stage.target.sessionId, epoch: stage.epoch },
      [
        {
          ordinal,
          ownerFence: 0,
          executionOwner: null,
          hidden: false,
          item,
          turnItemId: item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null,
          originalStopNoteJson: note.originalStopNoteJson,
          queueCommandTurn: !!failure.commandTurn,
          queueFailedOutcome: !!failure.failedOutcome,
          queueFailedAt: failure.failedAt,
          queueFailureWitnessedThrough: failure.witnessedThrough,
          queueFailureReportTurnItemId: failure.reportTurnItemId
        }
      ],
      true,
      false,
      prepared
    )
    refreshJournalDomainQueueFailureReports(
      db,
      stageTarget,
      [
        stored?.queue_failure_report_turn_item_id == null
          ? null
          : String(stored.queue_failure_report_turn_item_id),
        failure.reportTurnItemId
      ],
      rendered.sequence
    )
    const claims =
      item.body.kind === 'message'
        ? [
            ...agentSessionAttachmentReferences(
              agentSessionAttachmentStoreRoot(stateDirectory),
              item.body
            )
          ]
        : []
    next.auxiliary = {
      item,
      ordinal,
      oldNames: previous ? journalDomainNamedSubagentIds(previous) : [],
      oldName: 0,
      names,
      name: 0,
      claims,
      claim: 0
    }
    next.derived = scope.snapshot()
    next.count++
    next.lastItemId = itemId
    next.lastActivity = Math.max(next.lastActivity, item.observedAt)
    accepted++
    units++
    bytes += size
  }
  return { next, accepted, auxiliary: next.auxiliary !== undefined }
}
