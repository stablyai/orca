// The background copy's share of the main thread, as a token bucket refilled at the share and
// holding at most a small burst. Every task the copy runs is charged to it; the copy waits for
// the share to catch up only between chats, where it holds no chat's lock and owes no one an
// answer. Inside a chat its tasks only yield to the next macrotask, so anyone who opens or
// commands that chat meanwhile waits for the rest of its copy, never for the pace. So any second
// gives the copy at most the share, the burst and one chat's own work. Awaits that are not the
// copy's work (a chat's lock, a disk probe) are not charged. Quit ends a wait at once.

import { performance } from 'node:perf_hooks'
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises'

/** The copy's share of the main thread's wall time, waits on disk included. */
export const PER_CHAT_FILE_COPY_SHARE = 0.15
/** Main-thread time the copy may take at once after it has been idle. */
export const PER_CHAT_FILE_COPY_BURST_MS = 50

export class StructuredAgentSessionPerChatFileCopyPace {
  private tokens = PER_CHAT_FILE_COPY_BURST_MS
  private refilledAt: number
  private taskStart: number
  private counting = true
  private readonly stopping = new AbortController()

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) =>
      sleep(ms, undefined, { signal }).catch(() => undefined)
  ) {
    this.refilledAt = clock()
    this.taskStart = this.refilledAt
  }

  /** Quit: no task waits any more. */
  stop(): void {
    this.stopping.abort()
  }

  /** A task of the copy begins: after a wait between runs, or after an uncharged await. */
  begin(): void {
    this.taskStart = this.clock()
    this.counting = true
  }

  /** Charges the task so far, and charges nothing more until `begin`: for an await that is not
   *  the copy's own work. */
  pause(): void {
    this.charge()
    this.counting = false
  }

  /** Ends the copy's current task between chats: on to the next macrotask, or, when the copy has
   *  taken more than its share, after a wait that brings the share back. */
  yieldTask = async (): Promise<void> => {
    this.charge()
    if (this.tokens < 0 && !this.stopping.signal.aborted) {
      await this.wait(-this.tokens / PER_CHAT_FILE_COPY_SHARE, this.stopping.signal)
      this.tokens = 0
      this.refilledAt = this.clock()
    } else {
      await yieldToEventLoop()
    }
    this.begin()
  }

  /** Runs `task` inside the chat's lock, uncharged while it waits for the lock; its tasks end with
   *  `yieldInChat`. */
  inChat<T>(
    serialize: <R>(sessionId: string, task: () => Promise<R>) => Promise<R>,
    sessionId: string,
    task: (yieldTask: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    this.pause()
    return serialize(sessionId, () => {
      this.begin()
      return task(this.yieldInChat)
    })
  }

  /** Ends a task inside a chat: on to the next macrotask, never a wait; its debt is paid at the
   *  next `yieldTask`. */
  yieldInChat = async (): Promise<void> => {
    this.charge()
    await yieldToEventLoop()
    this.begin()
  }

  private charge(): void {
    if (!this.counting) {
      return
    }
    const now = this.clock()
    // Refilled while idle before the task, up to the burst; the task refills as it spends.
    this.tokens = Math.min(
      PER_CHAT_FILE_COPY_BURST_MS,
      this.tokens + (this.taskStart - this.refilledAt) * PER_CHAT_FILE_COPY_SHARE
    )
    this.tokens -= (now - this.taskStart) * (1 - PER_CHAT_FILE_COPY_SHARE)
    this.refilledAt = now
    this.taskStart = now
  }
}
