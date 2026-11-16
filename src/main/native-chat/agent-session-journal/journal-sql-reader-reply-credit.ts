/**
 * Only a reader knows a reply's size before posting it, so the byte budget lives with the readers:
 * each adds its reply's bytes to a shared total before posting and main subtracts them once the
 * caller has taken the reply. A reader waits while the replies main has not consumed would exceed
 * the budget, so a busy main faces at most the budget plus one reply, whatever the reads return.
 */
export const JOURNAL_READER_REPLY_CREDIT_BYTES = 32 * 2 ** 20
/** A leaked credit must never hang a reader: past this it posts anyway and says so. */
export const JOURNAL_READER_REPLY_CREDIT_WAIT_MS = 10_000
const WAIT_SLICE_MS = 100
const READERS = 16
/** 0 counts releases, waking any waiting reader; 1 is the total; 2 + index is one reader's share. */
const WAKE = 0
const TOTAL = 1

export type JournalReaderReplyCreditGrant = { index: number; credit: SharedArrayBuffer }

/** Main side: one per reader pool. */
export class JournalReaderReplyCredit {
  private readonly counters: Int32Array
  private readonly free: number[] = Array.from({ length: READERS }, (_, index) => index)
  readonly credit = new SharedArrayBuffer((READERS + 2) * 4)

  constructor() {
    this.counters = new Int32Array(this.credit)
  }

  /** Undefined when every index is held: that reader posts without waiting, as before. */
  claim(): JournalReaderReplyCreditGrant | undefined {
    const index = this.free.shift()
    return index === undefined ? undefined : { index, credit: this.credit }
  }

  release(index: number, bytes: number): void {
    returnJournalReaderReplyCredit({ index, credit: this.credit }, bytes)
  }

  /** The reader exited: whatever it posted and main never consumed can no longer hold credit. */
  retire(index: number): void {
    const share = Atomics.exchange(this.counters, 2 + index, 0)
    Atomics.sub(this.counters, TOTAL, share)
    this.free.push(index)
    wake(this.counters)
  }

  outstandingBytes(): number {
    return Atomics.load(this.counters, TOTAL)
  }
}

function wake(counters: Int32Array): void {
  Atomics.add(counters, WAKE, 1)
  Atomics.notify(counters, WAKE)
}

/** Main after consumption, or a reader whose post failed after taking credit. */
export function returnJournalReaderReplyCredit(
  grant: JournalReaderReplyCreditGrant,
  bytes: number
): void {
  const counters = new Int32Array(grant.credit)
  Atomics.sub(counters, 2 + grant.index, bytes)
  Atomics.sub(counters, TOTAL, bytes)
  wake(counters)
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
    const woken = Atomics.load(counters, WAKE)
    const held = Atomics.load(counters, TOTAL)
    if (held === 0 || held + bytes <= JOURNAL_READER_REPLY_CREDIT_BYTES) {
      // Readers race for the same room; only the one whose view still holds takes it.
      if (Atomics.compareExchange(counters, TOTAL, held, held + bytes) === held) {
        break
      }
      continue
    }
    if (now() >= deadline) {
      granted = false
      Atomics.add(counters, TOTAL, bytes)
      break
    }
    Atomics.wait(counters, WAKE, woken, WAIT_SLICE_MS)
  }
  Atomics.add(counters, 2 + grant.index, bytes)
  return granted
}
