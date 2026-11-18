import type { JournalFirstSubmittedPrompt } from '../../native-chat/agent-session-journal/journal-domain-first-submitted-prompt'

export type NativeFirstMessageLookup =
  | { kind: 'found'; prompt: string; submittedAt: number }
  | { kind: 'none' }
  /** A session hit the scan bound: no earliest message can be certified, so name from changes. */
  | { kind: 'incomplete' }
  /** Read failed, the scan was abandoned, or the feature's read capacity is full: retryable. */
  | { kind: 'unreadable' }

export type NativeFirstMessageReads = {
  listSessionIds: () => Promise<string[]>
  readFirst: (sessionId: string, sinceMs: number) => Promise<JournalFirstSubmittedPrompt>
}

type PhysicalRead = {
  promise: Promise<NativeFirstMessageLookup>
  /** Each joined attempt's liveness; the scan continues only while one still wants the result. */
  wanters: Set<() => boolean>
}

// Leases outlive a logical timeout until the physical read settles, so expiries cannot pile up reads.
const physicalReads = new Map<string, PhysicalRead>()
export const MAX_NATIVE_FIRST_MESSAGE_READS = 2

export function resetNativeFirstMessageReads(): void {
  physicalReads.clear()
}

/** Joins a draining read for the same incarnation before applying feature-wide capacity. */
export function leaseNativeFirstMessageRead(
  incarnation: string,
  wanted: () => boolean,
  read: (stillWanted: () => boolean) => Promise<NativeFirstMessageLookup>
): Promise<NativeFirstMessageLookup> {
  const draining = physicalReads.get(incarnation)
  if (draining) {
    draining.wanters.add(wanted)
    return draining.promise
  }
  if (physicalReads.size >= MAX_NATIVE_FIRST_MESSAGE_READS) {
    return Promise.resolve({ kind: 'unreadable' })
  }
  const wanters = new Set([wanted])
  const stillWanted = () => [...wanters].some((isWanted) => isWanted())
  const entry: PhysicalRead = {
    wanters,
    promise: read(stillWanted).catch((): NativeFirstMessageLookup => ({ kind: 'unreadable' }))
  }
  physicalReads.set(incarnation, entry)
  void entry.promise.finally(() => {
    if (physicalReads.get(incarnation) === entry) {
      physicalReads.delete(incarnation)
    }
  })
  return entry.promise
}

type Candidate = { prompt: string; submittedAt: number; sequence: number; sessionId: string }

/** D4 order: submission time, then item sequence; session id only makes an exact tie deterministic. */
function precedes(left: Candidate, right: Candidate): boolean {
  if (left.submittedAt !== right.submittedAt) {
    return left.submittedAt < right.submittedAt
  }
  if (left.sequence !== right.sequence) {
    return left.sequence < right.sequence
  }
  return left.sessionId < right.sessionId
}

/** The earliest qualifying native-chat message of the workspace, one point read at a time. */
export async function readNativeFirstMessage(
  reads: NativeFirstMessageReads,
  sinceMs: number,
  stillWanted: () => boolean = () => true
): Promise<NativeFirstMessageLookup> {
  let earliest: Candidate | null = null
  for (const sessionId of await reads.listSessionIds()) {
    // Abandoned: submit no further reads, and never report a partial scan as complete.
    if (!stillWanted()) {
      return { kind: 'unreadable' }
    }
    const first = await reads.readFirst(sessionId, sinceMs)
    if (first.kind === 'incomplete') {
      return { kind: 'incomplete' }
    }
    if (first.kind === 'found') {
      const candidate = { ...first, sessionId }
      if (!earliest || precedes(candidate, earliest)) {
        earliest = candidate
      }
    }
  }
  return earliest
    ? { kind: 'found', prompt: earliest.prompt, submittedAt: earliest.submittedAt }
    : { kind: 'none' }
}
