import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'

export type JournalSourceIdentity = {
  echoes: JournalSourceEchoes
  submissions: Map<string, string>
  contextSequence: number
}

type Entry = { submission: AgentJournalSubmission; ordinal: number }

/** Source replay retains historical joins; fingerprint heaps avoid a history scan per new echo. */
export class JournalSourceEchoes {
  private readonly heaps = new Map<string, Entry[]>()
  private readonly current = new Map<string, Entry>()
  private readonly ordinals = new Map<string, number>()

  add(submission: AgentJournalSubmission): void {
    const id = submission.clientMessageId
    const ordinal = this.ordinals.get(id) ?? this.ordinals.size
    this.ordinals.set(id, ordinal)
    const entry = { submission, ordinal }
    this.current.set(id, entry)
    const heap = this.heaps.get(submission.payloadFingerprint) ?? []
    this.heaps.set(submission.payloadFingerprint, heap)
    let at = heap.length
    heap.push(entry)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!this.before(entry, heap[parent])) {
        break
      }
      heap[at] = heap[parent]
      at = parent
    }
    heap[at] = entry
  }

  first(
    fingerprint: string,
    eligible: (submission: AgentJournalSubmission) => boolean
  ): AgentJournalSubmission | undefined {
    const heap = this.heaps.get(fingerprint)
    while (heap?.length) {
      const entry = heap[0]
      if (
        this.current.get(entry.submission.clientMessageId) === entry &&
        eligible(entry.submission)
      ) {
        return entry.submission
      }
      this.pop(heap)
    }
    this.heaps.delete(fingerprint)
    return undefined
  }

  private before(a: Entry, b: Entry): boolean {
    return (
      a.submission.submittedAt < b.submission.submittedAt ||
      (a.submission.submittedAt === b.submission.submittedAt && a.ordinal < b.ordinal)
    )
  }

  private pop(heap: Entry[]): void {
    const last = heap.pop()!
    if (!heap.length) {
      return
    }
    let at = 0
    while (at * 2 + 1 < heap.length) {
      let child = at * 2 + 1
      if (child + 1 < heap.length && this.before(heap[child + 1], heap[child])) {
        child++
      }
      if (!this.before(heap[child], last)) {
        break
      }
      heap[at] = heap[child]
      at = child
    }
    heap[at] = last
  }
}
