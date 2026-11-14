export class QueuedMessageNotConsumableError extends Error {
  constructor(
    readonly messageId: string,
    readonly expected: 'waiting' | 'returned'
  ) {
    super(`queued message ${messageId} is no longer ${expected}`)
    this.name = 'QueuedMessageNotConsumableError'
  }
}

/** Whether an agent's queued message still belongs to this conversation at handover; `unavailable`
 *  means whoever decides cannot say now, so the card waits rather than run or vanish. */
export type QueuedMessageOwed = 'owed' | 'stale' | 'unavailable'

export class QueuedMessageNotOwedError extends Error {
  constructor(
    readonly messageId: string,
    readonly owed: Exclude<QueuedMessageOwed, 'owed'>
  ) {
    super(`queued message ${messageId} is ${owed}`)
    this.name = 'QueuedMessageNotOwedError'
  }
}
