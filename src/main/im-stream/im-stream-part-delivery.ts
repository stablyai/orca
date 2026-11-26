// An answer's parts sent in order under one of the two guarantees a platform's send can give, each
// step written down first, so a retry or a restart resumes where the last attempt stopped.
//
// exactly-once: the platform takes a resend as the same message (an idempotency key, or an edit of
//   the same message), so a part whose outcome is unknown goes again.
// at-most-once: a resend may show twice, so a part whose outcome is unknown never goes again; it
//   settles as unconfirmed, for the platform to offer the owner a manual resend.

export type ImDeliveryGuarantee = 'exactly-once' | 'at-most-once'

export type ImPartsChannel = {
  guarantee: ImDeliveryGuarantee
  send(text: string, index: number): Promise<void>
  /** At most once: whether a failed send may have been shown anyway (its answer was lost); any
   *  other failure was not. Absent: every failure may have been. */
  unknown?: (error: unknown) => boolean
}

/** What the last attempt wrote down, parts counted from 0. */
export type ImPartsProgress = {
  /** Parts settled, in order. */
  sent: number
  /** A part handed to the platform whose outcome was never written: a restart came between. */
  sending: number | null
}

export type ImPartsLog = {
  /** Before part `index` goes. */
  sending(index: number): Promise<void>
  /** Part `index` is done: shown, or (at most once) given up as unconfirmed. */
  settled(index: number, shown: boolean): Promise<void>
  /** Part `index` was not shown; the next attempt sends it. */
  refused(index: number): Promise<void>
}

/** Sends parts from `progress.sent` on and returns those that may or may not have shown (never
 *  under exactly-once). Throws a failure it can't settle after writing it down, so a later call
 *  resumes from that part. */
export async function sendImParts(
  parts: readonly string[],
  progress: ImPartsProgress,
  channel: ImPartsChannel,
  log: ImPartsLog
): Promise<number[]> {
  const atMostOnce = channel.guarantee === 'at-most-once'
  const unconfirmed: number[] = []
  for (let index = progress.sent; index < parts.length; index++) {
    const resumed = progress.sending === index
    if (resumed && atMostOnce) {
      // Sent before a restart, and the platform may have shown it: never twice.
      await log.settled(index, false)
      unconfirmed.push(index)
      continue
    }
    if (!resumed) {
      await log.sending(index)
    }
    try {
      await channel.send(parts[index]!, index)
    } catch (error) {
      if (!atMostOnce) {
        throw error
      }
      if (channel.unknown?.(error) ?? true) {
        await log.settled(index, false)
        unconfirmed.push(index)
        continue
      }
      await log.refused(index)
      throw error
    }
    await log.settled(index, true)
  }
  return unconfirmed
}
