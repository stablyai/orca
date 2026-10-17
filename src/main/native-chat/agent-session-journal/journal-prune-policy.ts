import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalItemRow, JournalRow } from './journal-row-schema'

export type JournalPruneCandidate = {
  seq: number
  revision: number
  signature: string
  removable: boolean
  savedAt: number
  observedAt: number
}

export type JournalPruneCandidates = {
  get: (itemId: string) => JournalPruneCandidate | undefined
  set: (itemId: string, candidate: JournalPruneCandidate) => void
  delete: (itemId: string) => void
}

/** Keep creation and both sides of semantic transitions; only full snapshot rewrites retire. */
export class JournalPrunePolicy {
  constructor(private readonly candidates: JournalPruneCandidates) {}

  observe(row: JournalRow, savedAt: number): number | null {
    if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        this.candidates.delete(mutation.itemId)
      }
      return null
    }
    if (row.kind === 'tombstone') {
      this.candidates.delete(row.itemId)
      return null
    }
    if (row.kind !== 'item') {
      return null
    }
    const signature = pruneSignature(row)
    if (signature === null) {
      this.candidates.delete(row.itemId)
      return null
    }
    const previous = this.candidates.get(row.itemId)
    if (previous && row.revision <= previous.revision) {
      return null
    }
    const same = previous?.signature === signature
    this.candidates.set(row.itemId, {
      seq: row.seq,
      revision: row.revision,
      signature,
      removable: same,
      savedAt,
      observedAt: row.ts
    })
    return previous?.removable &&
      same &&
      previous.savedAt <= savedAt &&
      previous.observedAt <= row.ts
      ? previous.seq
      : null
  }
}

function pruneSignature(row: JournalItemRow): string | null {
  const { body } = row
  const turn = readAgentJournalTurn(body)
  // Echo fingerprints, prompts, context clears and stop notes have effects beyond their body.
  if (
    (body.kind === 'message' && body.role === 'user') ||
    (!['message', 'tool-call', 'diff', 'turn'].includes(body.kind) && turn === null)
  ) {
    return null
  }
  return JSON.stringify([
    body.kind,
    body.kind === 'message' ? [body.role, body.state] : null,
    body.kind === 'tool-call' ? [body.state, body.endedAs] : null,
    turn ? [turn.turnId, turn.state] : null,
    row.fence,
    row.ownerFence,
    row.recovered,
    row.turnScope,
    agentJournalLinkageFields(row)
  ])
}
