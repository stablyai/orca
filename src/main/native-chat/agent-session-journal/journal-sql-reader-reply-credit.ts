/**
 * Only a reader knows a reply's size before posting it, so the byte budget lives with the readers:
 * each adds its reply's bytes to a shared total before posting and main subtracts them once the
 * caller has taken the reply. A reader waits while the replies main has not consumed would exceed
 * the budget, so a busy main faces at most the budget plus one reply, whatever the reads return.
 */
export const JOURNAL_READER_REPLY_CREDIT_BYTES = 64 * 2 ** 20
/**
 * Main releasing recently while room never comes is a leak or a starved large reply: post after
 * this. Main releasing nothing lately is a stall: keep holding.
 */
export const JOURNAL_READER_REPLY_CREDIT_WAIT_MS = 10_000
/** A release this recent means main is still consuming. */
export const JOURNAL_READER_REPLY_RECENT_RELEASE_MS = 2_000
/** No wait outlasts this, so a leaked credit can't hang a reader; a main stalled this long is hung. */
export const JOURNAL_READER_REPLY_STALL_WAIT_MS = 60_000
/** Short enough that a terminated reader stops promptly. */
export const JOURNAL_READER_REPLY_CREDIT_WAIT_SLICE_MS = 100
const READERS = 16
/** 0 counts releases, waking any waiting reader; 1 is the total; 2 + index is one reader's share. */
const WAKE = 0
const TOTAL = 1

export type JournalReaderReplyCreditGrant = { index: number; credit: SharedArrayBuffer }

/** Main's hold on one reader's index; after retire, late releases are ignored. */
export type JournalReaderReplyCreditClaim = {
  grant: JournalReaderReplyCreditGrant
  release: (bytes: number) => void
  retire: () => void
}

/** Main side: one per reader pool. */
export class JournalReaderReplyCredit {
  private readonly counters: Int32Array
  private readonly free: number[] = Array.from({ length: READERS }, (_, index) => index)
  readonly credit = new SharedArrayBuffer((READERS + 2) * 4)

  constructor() {
    this.counters = new Int32Array(this.credit)
  }

  /** Undefined when every index is held: that reader posts without waiting, as before. */
  claim(): JournalReaderReplyCreditClaim | undefined {
    const index = this.free.shift()
    if (index === undefined) {
      return undefined
    }
    const grant = { index, credit: this.credit }
    let retired = false
    return {
      grant,
      release: (bytes) => {
        if (!retired) {
          returnJournalReaderReplyCredit(grant, bytes)
        }
      },
      retire: () => {
        if (!retired) {
          retired = true
          this.retire(index)
        }
      }
    }
  }

  /** The reader exited: whatever it posted and main never consumed can no longer hold credit. */
  private retire(index: number): void {
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

/** The release counter a waiting reader blocks on; only the reader's worker entry waits. */
export function journalReaderReplyCreditReleases(grant: JournalReaderReplyCreditGrant): {
  counters: Int32Array
  index: number
} {
  return { counters: new Int32Array(grant.credit), index: WAKE }
}

/** One attempt, never blocking: true when the reply's bytes now count against the budget. */
export function tryTakeJournalReaderReplyCredit(
  grant: JournalReaderReplyCreditGrant,
  bytes: number
): boolean {
  const counters = new Int32Array(grant.credit)
  while (true) {
    const held = Atomics.load(counters, TOTAL)
    if (held !== 0 && held + bytes > JOURNAL_READER_REPLY_CREDIT_BYTES) {
      return false
    }
    // Readers race for the same room; only the one whose view still holds takes it.
    if (Atomics.compareExchange(counters, TOTAL, held, held + bytes) === held) {
      Atomics.add(counters, 2 + grant.index, bytes)
      return true
    }
  }
}

/** A reader that gave up waiting still counts what it posts. */
export function forceJournalReaderReplyCredit(
  grant: JournalReaderReplyCreditGrant,
  bytes: number
): void {
  const counters = new Int32Array(grant.credit)
  Atomics.add(counters, TOTAL, bytes)
  Atomics.add(counters, 2 + grant.index, bytes)
}
