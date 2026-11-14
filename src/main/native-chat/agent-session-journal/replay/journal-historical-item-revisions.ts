import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { journalHistoryAccess } from '../database/journal-history-access'
import { agentJournalItemSubagentId } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type Database from '../../../sqlite/sync-database'
import { storedItem } from '../durable-rows/journal-storage-schema'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'
import { outcomeFormat1Stored } from '../outcomes/journal-outcome-format-1'
import { JournalOutcomeDecodeError } from '../writing/journal-write-guards'

import type {
  JournalRestoreEvidence,
  HistoricalJournalItemRevision
} from './journal-restore-evidence'
export type { HistoricalJournalItemRevision } from './journal-restore-evidence'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: proof reads strict identity/request fields, never opaque legacy sender metadata.
const admittedItem = storedItem.transform((item) => item as AgentJournalRenderItem)

/** Read exact revisions, including overwritten outcomes; newest-key snapshots cannot prove a cancellation's cause. */
export function readHistoricalJournalItemRevisions(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  itemIds: ReadonlySet<string>,
  raw: JournalRestoreEvidence,
  latestOnly = false
): {
  revisions: Map<string, HistoricalJournalItemRevision[]>
  answers: Map<string | null, number>
} {
  const source = journalOutcomeSource(db, sessionId, epoch)
  const ids = new Set(itemIds)
  if (!latestOnly) {
    for (const [id, history] of raw.revisions) {
      if (history.some(({ item }) => isResolvedRequest(item))) {
        ids.add(id)
      }
    }
    if (source) {
      const access = journalHistoryAccess(db)
      if (!access?.covered(sessionId, epoch, source.generation, source.through)) {
        throw new JournalOutcomeDecodeError('saved request history is not ready')
      }
      for (const record of db
        .prepare(`SELECT DISTINCT entry_key FROM journal_history_locators
        WHERE session_id = ? AND epoch = ? AND generation = ? AND kind = 4
          AND incarnation = ? AND seq <= ?`)
        .iterate(
          sessionId,
          epoch,
          source.generation,
          access.incarnation(sessionId, epoch, source.generation),
          source.through
        )) {
        ids.add(z.string().parse(JSON.parse(String(record.entry_key))))
      }
    }
  }
  const revisions = new Map<string, HistoricalJournalItemRevision[]>()
  for (const id of ids) {
    const history: HistoricalJournalItemRevision[] = []
    for (const revision of raw.revisions.get(id) ?? []) {
      appendRevision(history, revision)
    }
    revisions.set(id, history)
  }
  if ((source && raw.through !== source.prefix) || (!source && raw.through === 0)) {
    throw new JournalOutcomeDecodeError('saved request history is incomplete')
  }
  if (!source) {
    return { revisions, answers: answerFrontier(revisions) }
  }
  const items = db.prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key = ?
      AND seq <= ? ORDER BY seq ${latestOnly ? 'DESC LIMIT 1' : ''}`)
  const revisionOrigin =
    db.prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key = ?
      AND seq <= ? ORDER BY seq`)
  const origins = db.prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ? AND seq = ?
      AND field = 'appliedSettlementIds' AND deleted = 0`)
  const fences = db.prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ? AND field = ? AND entry_key = ?
      AND seq <= ? ORDER BY seq DESC LIMIT 1`)
  const settlementIds = new Map<number, string[]>()
  for (const [id, history] of revisions) {
    const key = JSON.stringify(id)
    const records = items.all(source.generation, key, source.through)
    if (latestOnly && records[0]) {
      const latest = decodeJournalOutcome(records[0])
      if (!latest.deleted) {
        const item = admittedItem.parse(JSON.parse(latest.json))
        // A snapshot of an unchanged revision does not become a new cancellation mutation.
        let origin: (typeof records)[number] | undefined
        for (const record of revisionOrigin.iterate(source.generation, key, source.through)) {
          const value = decodeJournalOutcome(record)
          if (value.deleted) {
            continue
          }
          const previous = admittedItem.parse(JSON.parse(value.json))
          if (previous.itemId !== id) {
            throw new JournalOutcomeDecodeError('saved request history names a different item')
          }
          if (previous.revision === item.revision) {
            if (!isDeepStrictEqual(previous, item)) {
              throw new JournalOutcomeDecodeError(
                'saved request revision changed without a new revision'
              )
            }
            origin ??= record
          }
        }
        if (origin) {
          records[0] = origin
        }
      }
    }
    for (const stored of records) {
      const value = decodeJournalOutcome(stored)
      let ids = settlementIds.get(value.seq)
      if (!ids) {
        ids = origins.all(source.generation, value.seq).map((origin) => {
          const admitted = decodeJournalOutcome(origin)
          return outcomeFormat1Stored.appliedSettlementIds.parse(JSON.parse(admitted.json))[0]
        })
        settlementIds.set(value.seq, ids)
      }
      const provenance = (field: 'itemFences' | 'itemExecutionOwners'): number | undefined => {
        const record = fences.get(source.generation, field, key, value.seq)
        if (!record) {
          return field === 'itemFences'
            ? history.at(-1)?.ownerFence
            : history.at(-1)?.executionOwner
        }
        const admitted = decodeJournalOutcome(record)
        if (admitted.deleted) {
          return undefined
        }
        return outcomeFormat1Stored[field].parse(JSON.parse(admitted.json))[1]
      }
      const item = value.deleted ? null : admittedItem.parse(JSON.parse(value.json))
      if (item && item.itemId !== id) {
        throw new JournalOutcomeDecodeError('saved request history names a different item')
      }
      const revision = {
        sequence: value.seq,
        item,
        ownerFence: provenance('itemFences'),
        executionOwner: provenance('itemExecutionOwners'),
        settlementIds: ids
      }
      appendRevision(history, revision)
    }
  }
  return { revisions, answers: answerFrontier(revisions) }
}

function appendRevision(
  history: HistoricalJournalItemRevision[],
  revision: HistoricalJournalItemRevision
): void {
  const previous = history.at(-1)
  if (revision.item && previous?.item?.revision === revision.item.revision) {
    if (
      !isDeepStrictEqual(previous.item, revision.item) ||
      previous.ownerFence !== revision.ownerFence ||
      previous.executionOwner !== revision.executionOwner
    ) {
      throw new JournalOutcomeDecodeError('saved request revision changed without a new revision')
    }
    return
  }
  history.push(revision)
}

function isResolvedRequest(item: AgentJournalRenderItem | null): boolean {
  return Boolean(
    item &&
    (item.body.kind === 'question' || item.body.kind === 'approval') &&
    item.body.resolution.state === 'resolved'
  )
}

function answerFrontier(
  revisions: Map<string, HistoricalJournalItemRevision[]>
): Map<string | null, number> {
  const answers = new Map<string | null, number>()
  for (const history of revisions.values()) {
    for (const { item, sequence } of history) {
      if (item && isResolvedRequest(item)) {
        const stream = agentJournalItemSubagentId(item)
        answers.set(stream, Math.max(answers.get(stream) ?? 0, sequence))
      }
    }
  }
  return answers
}
