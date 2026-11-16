/**
 * Only a reader knows a reply's size before posting it, so the byte budget lives with the readers:
 * each adds its reply's bytes to its own counter before posting and main subtracts them once the
 * caller has taken the reply. A reader waits while the replies main has not consumed would exceed
 * the budget, so a busy main faces at most the budget plus one reply, whatever the reads return.
 */
export const JOURNAL_READER_REPLY_CREDIT_BYTES = 32 * 2 ** 20
/** A leaked credit must never hang a reader: past this it posts anyway and says so. */
export const JOURNAL_READER_REPLY_CREDIT_WAIT_MS = 10_000
const WAIT_SLICE_MS = 100
const READERS = 16
/** Index 0 counts releases, so a waiting reader wakes on any; index 1 + slot is a reader's bytes. */
const WAKE = 0

export type JournalReaderReplyCreditGrant = { index: number; credit: SharedArrayBuffer }

/** Main side: one per reader pool. */
export class JournalReaderReplyCredit {
  private readonly counters: Int32Array
  private readonly free: number[] = Array.from({ length: READERS }, (_, index) => index)
  readonly credit = new SharedArrayBuffer((READERS + 1) * 4)

  constructor() {
    this.counters = new Int32Array(this.credit)
  }

  /** Undefined when every index is held: that reader posts without waiting, as before. */
  claim(): JournalReaderReplyCreditGrant | undefined {
    const index = this.free.shift()
    return index === undefined ? undefined : { index, credit: this.credit }
  }

  release(index: number, bytes: number): void {
    Atomics.sub(this.counters, 1 + index, bytes)
    this.wake()
  }

  /** The reader exited: whatever it posted and main never consumed can no longer hold credit. */
  retire(index: number): void {
    Atomics.store(this.counters, 1 + index, 0)
    this.free.push(index)
    this.wake()
  }

  outstandingBytes(): number {
    return outstanding(this.counters)
  }

  private wake(): void {
    Atomics.add(this.counters, WAKE, 1)
    Atomics.notify(this.counters, WAKE)
  }
}

function outstanding(counters: Int32Array): number {
  let total = 0
  for (let index = 1; index < counters.length; index++) {
    total += Atomics.load(counters, index)
  }
  return total
}

/** Reader side, before posting a charged reply. Returns false when it gave up waiting. */
export function takeJournalReaderReplyCredit(
  grant: JournalReaderReplyCreditGrant,
  bytes: number,
  now: () => number = Date.now
): boolean {
  const counters = new Int32Array(grant.credit)
  const deadline = now() + JOURNAL_READER_REPLY_CREDIT_WAIT_MS
  let granted = true
  while (true) {
    const wake = Atomics.load(counters, WAKE)
    const held = outstanding(counters)
    if (held === 0 || held + bytes <= JOURNAL_READER_REPLY_CREDIT_BYTES) {
      break
    }
    if (now() >= deadline) {
      granted = false
      break
    }
    Atomics.wait(counters, WAKE, wake, WAIT_SLICE_MS)
  }
  Atomics.add(counters, 1 + grant.index, bytes)
  return granted
}
