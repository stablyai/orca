import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readCommandReceipt } from './command-receipt-table'

/** Only the original send's accepted coordinate can compare a retired enqueue boundary. */
export function journalInputAcceptance(
  db: Database.Database,
  sessionId: string,
  id: string
): AgentJournalCursor | undefined {
  const read = readCommandReceipt(db, { kind: 'global' }, id)
  if (
    read.verdict === 'readable' &&
    read.receipt.status === 'accepted' &&
    read.receipt.sessionId === sessionId &&
    read.receipt.method === 'agentSession.send' &&
    read.receipt.result.kind === 'journal-row'
  ) {
    return { epoch: read.receipt.result.epoch, sequence: read.receipt.result.sequence }
  }
  return undefined
}

/** Reuse comparable admission coordinates; original receipts remain the provenance authority. */
export function journalQueueRebase(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  previousEpoch: string | undefined,
  queued: readonly AgentJournalSubmission[],
  rebuilt: ReadonlyMap<string, number>
): (queuedAt: AgentJournalCursor | null) => AgentJournalCursor | null {
  type Position = { sequence: number; rebased: number }
  const comparableByEpoch = new Map<string, Position[]>()
  let originalPositions: Map<string, Position[]> | undefined
  const originals = () => {
    if (!originalPositions) {
      originalPositions = new Map()
      for (const submission of queued) {
        const original = journalInputAcceptance(db, sessionId, submission.clientMessageId)
        if (original) {
          const positions = originalPositions.get(original.epoch) ?? []
          positions.push({
            sequence: original.sequence,
            rebased: rebuilt.get(submission.clientMessageId) ?? 1
          })
          originalPositions.set(original.epoch, positions)
        }
      }
    }
    return originalPositions
  }
  return (queuedAt) => {
    if (queuedAt && previousEpoch !== undefined) {
      const boundary = queuedAt
      let comparable = comparableByEpoch.get(boundary.epoch)
      if (!comparable) {
        if (boundary.epoch === previousEpoch) {
          const current = queued.flatMap((submission) =>
            submission.acceptedSequence === undefined
              ? []
              : [
                  {
                    sequence: submission.acceptedSequence,
                    rebased: rebuilt.get(submission.clientMessageId) ?? 1
                  }
                ]
          )
          if (current.length === queued.length) {
            comparable = current
          } else {
            // Legacy missing admission places retain only comparable original coordinates.
            const missing = new Set(
              queued
                .filter((submission) => submission.acceptedSequence === undefined)
                .map((submission) => rebuilt.get(submission.clientMessageId))
            )
            comparable = [
              ...current,
              ...(originals().get(boundary.epoch) ?? []).filter((position) =>
                missing.has(position.rebased)
              )
            ]
          }
        } else {
          comparable = originals().get(boundary.epoch) ?? []
        }
        comparable.sort((a, b) => a.sequence - b.sequence)
        for (let i = 1; i < comparable.length; i++) {
          comparable[i].rebased = Math.max(comparable[i].rebased, comparable[i - 1].rebased)
        }
        comparableByEpoch.set(boundary.epoch, comparable)
      }
      if (comparable.length === queued.length) {
        let low = 0
        let high = comparable.length
        while (low < high) {
          const mid = (low + high) >>> 1
          if (comparable[mid].sequence <= boundary.sequence) {
            low = mid + 1
          } else {
            high = mid
          }
        }
        queuedAt = { epoch, sequence: low === 0 ? 1 : comparable[low - 1].rebased }
      }
    }
    return queuedAt
  }
}
