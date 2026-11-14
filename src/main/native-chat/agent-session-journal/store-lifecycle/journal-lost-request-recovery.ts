import type Database from '../../../sqlite/sync-database'
import { latestAgentSessionContextClearSequence } from '../../../../shared/agent-session/agent-session-context-clear'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readHistoricalJournalItemRevisions } from '../replay/journal-historical-item-revisions'
import {
  journalLostParentTurns,
  lostJournalRevision,
  provenLostJournalRequest
} from '../replay/journal-lost-request-proof'
import type { JournalRestoreEvidence } from '../replay/journal-restore-evidence'
import { journalItemRowBuilder } from '../writing/journal-row-builders'
import type { JournalRowWriter } from '../writing/journal-row-writer'
import type { JournalStoreHost } from './journal-store-collaborators'
import { journalPersonalStopAfter } from '../context-epochs/journal-personal-stop-frontier'
import { journalInputOrder } from '../input-order/journal-input-order'
import { journalOutcomeSource, type JournalOutcomeSource } from '../outcomes/journal-outcome-format'
import { journalHistoryAccess } from '../database/journal-history-access'
import { refreshJournalPersonalStops } from '../context-epochs/journal-personal-stop'

const stableNegatives = new WeakMap<Database.Database, Set<string>>()
const reportedFailures = new WeakMap<Database.Database, Set<string>>()
const MAX_MEMO = 2048

function boundedRemember(memo: Set<string>, key: string): void {
  memo.delete(key)
  memo.add(key)
  if (memo.size > MAX_MEMO) {
    memo.delete(memo.values().next().value!)
  }
}

/** Reuse admitted restore evidence, then commit all proven repairs on the ordinary write lane. */
export async function recoverLostJournalRequests(
  host: JournalStoreHost,
  writer: JournalRowWriter,
  raw: JournalRestoreEvidence | undefined,
  expected?: {
    epoch: string
    boundary: number
    source: JournalOutcomeSource | null
    revisions: ReadonlyMap<string, number>
  }
): Promise<'complete' | 'needs-history' | 'unavailable'> {
  if (!raw) {
    return 'complete'
  }
  const db = host.database().db
  const memo = stableNegatives.get(db) ?? new Set<string>()
  stableNegatives.set(db, memo)
  const inspected: string[] = []
  let needsHistory = false
  let unavailable = false
  try {
    await writer.enqueueRows(() => {
      const state = host.state()
      if (
        expected &&
        (state.epoch !== expected.epoch || state.contextBoundary !== expected.boundary)
      ) {
        return []
      }
      const cancelled = [...state.items.values()].filter(
        (item) =>
          (item.body.kind === 'question' || item.body.kind === 'approval') &&
          item.body.resolution.state === 'cancelled' &&
          item.turnScope?.kind === 'turn' &&
          (!expected || expected.revisions.get(item.itemId) === item.revision)
      )
      if (!cancelled.length) {
        return []
      }
      if (
        raw.sourceIdentity === null ||
        raw.sourceIdentity !== journalHistoryAccess(db)?.sourceIdentity(state.sessionId)
      ) {
        needsHistory = true
        return []
      }
      if (!state.personalStops.complete) {
        refreshJournalPersonalStops(db, state)
        if (!state.personalStops.complete) {
          unavailable = true
          return []
        }
      }
      const source = journalOutcomeSource(db, state.sessionId, state.epoch)
      if (
        expected &&
        (source?.generation !== expected.source?.generation ||
          source?.prefix !== expected.source?.prefix ||
          source?.format !== expected.source?.format ||
          source?.marker !== expected.source?.marker)
      ) {
        return []
      }
      if (!source && raw.through !== state.lastSequence) {
        return []
      }
      const key = (item: (typeof cancelled)[number]) =>
        JSON.stringify([
          state.sessionId,
          state.epoch,
          state.contextBoundary,
          raw.sourceIdentity,
          source?.generation ?? 'raw',
          item.itemId,
          item.revision,
          host.journal().itemProvenance(item.itemId)
        ])
      const candidates = cancelled.filter((item) => !memo.has(key(item)))
      if (!candidates.length) {
        return []
      }
      const ids = new Set(candidates.map((item) => item.itemId))
      const latest = readHistoricalJournalItemRevisions(
        db,
        state.sessionId,
        state.epoch,
        ids,
        raw,
        true
      )
      const losses = candidates.filter((item) => {
        const last = latest.revisions.get(item.itemId)?.at(-1)
        if (!last?.item || last.item.revision !== item.revision) {
          return false
        }
        if (lostJournalRevision(state.sessionId, last)) {
          return true
        }
        inspected.push(key(item))
        return false
      })
      if (!losses.length) {
        return []
      }
      if (
        source &&
        !journalHistoryAccess(db)?.covered(
          state.sessionId,
          state.epoch,
          source.generation,
          source.through
        )
      ) {
        needsHistory = true
        return []
      }
      const proofIds = new Set(losses.map((item) => item.itemId))
      for (const item of losses) {
        if (item.turnScope?.kind === 'turn') {
          proofIds.add(item.turnScope.turnItemId)
        }
      }
      const proof = readHistoricalJournalItemRevisions(
        db,
        state.sessionId,
        state.epoch,
        proofIds,
        raw
      )
      const contextFloor = Math.max(
        state.contextBoundary - 1,
        latestAgentSessionContextClearSequence(state.items.values())
      )
      const parentTurn = journalLostParentTurns(state.sessionId, proof.revisions)
      return losses.flatMap((current) => {
        const original = provenLostJournalRequest({
          sessionId: state.sessionId,
          current,
          history: proof.revisions,
          parentTurn,
          answers: proof.answers,
          contextFloor,
          personAcceptedSequence: journalInputOrder(state).latestPersonAcceptedSequence(),
          removedTurnIds: state.removedTurnIds,
          personallyStopped: (item, turnId) =>
            journalPersonalStopAfter(state.personalStops, {
              sequence: item.sequence,
              at: item.observedAt,
              turnId
            }) !== 'clear'
        })
        const identity = parseAgentJournalItemKey(current.itemId)
        if (!original?.item || !identity || current.turnScope?.kind !== 'turn') {
          inspected.push(key(current))
          return []
        }
        return [
          journalItemRowBuilder(host.state, identity, original.item.body, {
            ...original.item,
            ...host.journal().itemProvenance(current.itemId),
            ownerFence: original.ownerFence,
            executionOwner: original.executionOwner,
            turnScope: current.turnScope,
            fence: state.highestFence,
            recovered: true
          })
        ]
      })
    })
  } catch {
    const reported = reportedFailures.get(db) ?? new Set<string>()
    reportedFailures.set(db, reported)
    if (!reported.has(host.identity.sessionId)) {
      console.warn('[journal-open] saved-request recovery skipped', {
        sessionId: host.identity.sessionId
      })
      boundedRemember(reported, host.identity.sessionId)
    }
    return 'unavailable'
  }
  for (const key of inspected) {
    boundedRemember(memo, key)
  }
  return unavailable ? 'unavailable' : needsHistory ? 'needs-history' : 'complete'
}
