import type { ReaderSlot } from './journal-sql-reader-slot'

/** Idle reader threads are retired so the hosted utility process can exit when chat reads stop. */
export const IDLE_READER_RETIRE_MS = 15_000

export type ReplacedReaderTotals = {
  receivedBytes: number
  consumedBytes: number
  creditWaitsExpired: number
}

function retireSlot(
  slot: ReaderSlot,
  replaced: ReplacedReaderTotals,
  retiring: Set<Promise<void>>
): void {
  const stats = slot.admissionStats()
  replaced.receivedBytes += stats.receivedBytes
  replaced.consumedBytes += stats.consumedBytes
  replaced.creditWaitsExpired += stats.creditWaitsExpired
  const closed = slot.close().finally(() => retiring.delete(closed))
  retiring.add(closed)
}

export function retireFailedJournalReaderSlots(
  slots: ReaderSlot[],
  replaced: ReplacedReaderTotals,
  retiring: Set<Promise<void>>
): void {
  for (let index = slots.length - 1; index >= 0; index--) {
    if (slots[index]!.failed) {
      const [failed] = slots.splice(index, 1)
      retireSlot(failed!, replaced, retiring)
    }
  }
}

export class JournalReaderIdleRetirer {
  private timer: ReturnType<typeof setTimeout> | undefined

  schedule(options: {
    isClosed: () => boolean
    slots: ReaderSlot[]
    getForkSlot: () => ReaderSlot | undefined
    getConversionSlot: () => ReaderSlot | undefined
    clearConversionSlot: () => void
    replaced: ReplacedReaderTotals
    retiring: Set<Promise<void>>
  }): void {
    if (options.isClosed() || options.slots.length === 0) {
      return
    }
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (options.isClosed()) {
        return
      }
      const forkSlot = options.getForkSlot()
      const conversionSlot = options.getConversionSlot()
      for (let index = options.slots.length - 1; index >= 0; index--) {
        const candidate = options.slots[index]!
        if (candidate.pendingCount !== 0 || candidate === forkSlot) {
          continue
        }
        options.slots.splice(index, 1)
        if (conversionSlot === candidate) {
          options.clearConversionSlot()
        }
        retireSlot(candidate, options.replaced, options.retiring)
      }
      if (options.slots.length > 0) {
        this.schedule(options)
      }
    }, IDLE_READER_RETIRE_MS)
    this.timer.unref?.()
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
