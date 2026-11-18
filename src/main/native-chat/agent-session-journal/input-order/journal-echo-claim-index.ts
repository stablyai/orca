import type { JournalInputEvidenceFacts } from '../journal-input-facts-storage'
import type { JournalInputIndexStorage, JournalInputPlaceStorage } from '../journal-index-storage'
import type { JournalKeyedMap } from '../journal-keyed-storage'
import { memoryJournalMap } from '../journal-memory-collections'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../../shared/agent-session/conversation-context/agent-session-context-clear'

/** What the echo claimant reads on every provider user message, kept per row instead of rescanned. */
export class JournalEchoClaimIndex {
  constructor(
    private readonly facts: JournalInputEvidenceFacts,
    private readonly indexes: JournalInputIndexStorage
  ) {}

  /** Known inputs sent with this fingerprint, in (submittedAt, ordinal) order; `open` leaves out retired echoes. */
  candidates(fingerprint: string, open: boolean): Iterable<string> {
    const buckets = open ? this.facts.openEchoCandidates : this.facts.echoCandidates
    return buckets.get(fingerprint)?.orderedIds() ?? []
  }

  /** Echoes only grow while `state.inputs` stands, so an echoed input cannot claim again until refreshed. */
  retire(fingerprint: string, id: string): void {
    removeFromBucket(this.facts.openEchoCandidates, fingerprint, id)
  }

  /** `state.inputs` was replaced; every known input is open again. */
  readmit(state: JournalReducerState): void {
    for (const id of memoryJournalMap(this.facts.echoFingerprints).keys()) {
      const entry = state.submissions.get(id)
      if (entry) {
        this.file(this.facts.openEchoCandidates, id, entry)
      }
    }
  }

  refresh(id: string, entry: AgentJournalSubmission | undefined): void {
    const { echoCandidates, openEchoCandidates, echoFingerprints } = this.facts
    const prior = echoFingerprints.get(id)
    if (prior !== undefined && prior !== entry?.payloadFingerprint) {
      removeFromBucket(echoCandidates, prior, id)
      removeFromBucket(openEchoCandidates, prior, id)
      echoFingerprints.delete(id)
    }
    if (entry) {
      this.file(echoCandidates, id, entry)
      this.file(openEchoCandidates, id, entry)
      echoFingerprints.set(id, entry.payloadFingerprint)
    }
  }

  latestClearSequence(state: JournalReducerState): number {
    let dividers = this.facts.clearDividers
    if (!dividers) {
      dividers = this.indexes.place('clear-dividers')
      for (const item of memoryJournalMap(state.items).values()) {
        if (isAgentSessionContextClear(item.body)) {
          dividers.setPosition(item.itemId, item.sequence)
        }
      }
      this.facts.clearDividers = dividers
    }
    return Math.max(0, dividers.allPlaces().position)
  }

  /** Follow one item write once dividers are seeded; every item set or delete in a fold calls this. */
  noteItem(state: JournalReducerState, itemId: string): void {
    const dividers = this.facts.clearDividers
    const item = dividers && state.items.get(itemId)
    if (item && isAgentSessionContextClear(item.body)) {
      dividers.setPosition(itemId, item.sequence)
    } else {
      dividers?.delete(itemId)
    }
  }

  private file(
    buckets: JournalKeyedMap<string, JournalInputPlaceStorage>,
    id: string,
    entry: AgentJournalSubmission
  ): void {
    const fingerprint = entry.payloadFingerprint
    const bucket = buckets.get(fingerprint) ?? this.indexes.place('echo-candidates', fingerprint)
    bucket.setPosition(id, entry.submittedAt, this.facts.ordinals.get(id) ?? Infinity)
    buckets.set(fingerprint, bucket)
  }
}

function removeFromBucket(
  buckets: JournalKeyedMap<string, JournalInputPlaceStorage>,
  fingerprint: string,
  id: string
): void {
  const bucket = buckets.get(fingerprint)
  bucket?.delete(id)
  if (bucket?.isEmpty()) {
    buckets.delete(fingerprint)
  }
}
