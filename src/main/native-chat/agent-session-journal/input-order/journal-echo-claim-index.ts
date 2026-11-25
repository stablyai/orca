import type { JournalInputEvidenceFacts } from '../journal-input-facts-storage'
import type { JournalInputIndexStorage, JournalInputPlaceStorage } from '../journal-index-storage'
import type { JournalKeyedMap } from '../journal-keyed-storage'
import { memoryJournalMap } from '../journal-memory-collections'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
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

  /** Members are the inputs the scan could reach: refreshed by the owner, with their own item present. */
  refresh(state: JournalReducerState, id: string, entry: AgentJournalSubmission | undefined): void {
    const { echoCandidates, openEchoCandidates, echoFingerprints } = this.facts
    const member =
      entry && this.facts.ordinals.has(id) && state.items.has(agentJournalSubmissionKey(id))
        ? entry
        : undefined
    const prior = echoFingerprints.get(id)
    if (prior !== undefined && prior !== member?.payloadFingerprint) {
      removeFromBucket(echoCandidates, prior, id)
      removeFromBucket(openEchoCandidates, prior, id)
      echoFingerprints.delete(id)
    }
    if (member) {
      this.file(echoCandidates, id, member)
      this.file(openEchoCandidates, id, member)
      echoFingerprints.set(id, member.payloadFingerprint)
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

  /** Every item set or delete in a fold calls this: dividers once seeded, and the item's own send. */
  noteItem(state: JournalReducerState, itemId: string, inputId: string | undefined): void {
    const dividers = this.facts.clearDividers
    const item = dividers && state.items.get(itemId)
    if (item && isAgentSessionContextClear(item.body)) {
      dividers.setPosition(itemId, item.sequence)
    } else {
      dividers?.delete(itemId)
    }
    if (inputId !== undefined) {
      this.refresh(state, inputId, state.submissions.get(inputId))
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
