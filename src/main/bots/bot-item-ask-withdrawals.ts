// Orca withdrawing Needs you asks whose `--while` settled: the worker they name ended, or their time
// passed. Driven like the usage-limit waits: the scheduler's minute, item writes and Dispatch changes.
import type { BotItemAskWhile, BotItemAskWithdrawn } from '../../shared/bots/bot-item-ask-while'
import type { BotItemAskWhileWorker } from './bot-item-ask-while-worker'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemRecord } from './bot-items-schema'

export type BotItemAskWithdrawalStore = Pick<
  BotItemsRemote,
  'askWhileQuestions' | 'withdrawAsk' | 'stillOwed' | 'viewRows'
>

export type BotItemAskWithdrawalDeps = {
  /** The profile's items store, only once it has a file. */
  store: () => BotItemAskWithdrawalStore | null
  /** How the worker a `dispatch:` ask names stands now. */
  worker: (ref: string) => BotItemAskWhileWorker
  /** The worker's title as its item shows it; null when unknown. */
  workerTitle: (refs: readonly string[]) => Promise<ReadonlyMap<string, string>>
  /** Items Orca moved. */
  changed: (items: readonly BotItemRecord[]) => void
  sendOwedMail: () => Promise<void>
}

/** A withdrawal's mail goes on being retried each minute for up to an hour, then is left to startup. */
const MAIL_RETRIES = 60

/** Why the ask is no longer needed, or null while it still is (or that can't be told). */
export function botItemAskSettled(
  askWhile: BotItemAskWhile,
  now: number,
  worker: (ref: string) => BotItemAskWhileWorker
): BotItemAskWithdrawn | null {
  if (askWhile.kind === 'until') {
    return now >= askWhile.at ? { kind: 'until', at: askWhile.at, state: 'passed' } : null
  }
  const state = worker(askWhile.ref)
  return state === 'completed' || state === 'failed' || state === 'stopped'
    ? { kind: 'dispatch', ref: askWhile.ref, state }
    : null
}

/** One pass at a time; a trigger during one runs it again. A failed pass is tried at the next trigger. */
export class BotItemAskWithdrawals {
  private running: Promise<void> | null = null
  private again = false
  /** Withdrawals whose mail the last send left owed, with the retries left. */
  private unsent = new Map<number, number>()
  /** Whether any `--while` ask was open at the last pass: none, and a tick costs nothing. */
  private armed = true

  constructor(private readonly deps: BotItemAskWithdrawalDeps) {}

  tick(now = Date.now()): void {
    if (this.armed || this.unsent.size > 0) {
      this.run(now)
    }
  }

  /** An item changed: it may now ask `--while`, which the next minute checks. */
  itemsChanged(): void {
    this.armed = true
  }

  /** A Dispatch changed: a worker an ask names may have ended. */
  dispatchChanged(): void {
    if (this.armed) {
      this.run()
    }
  }

  async settled(): Promise<void> {
    await this.running
  }

  private run(now?: number): void {
    this.again = true
    this.running ??= (async () => {
      while (this.again) {
        this.again = false
        await this.pass(now ?? Date.now()).catch((error: unknown) => {
          this.armed = true
          console.warn('[bots] items: withdrawing settled asks failed', error)
        })
      }
    })().finally(() => {
      this.running = null
    })
  }

  private async pass(now: number): Promise<void> {
    // One store for the whole pass: a profile switch meanwhile leaves the new profile to its own pass.
    const store = this.deps.store()
    if (!store) {
      return
    }
    const questions = await store.askWhileQuestions()
    this.armed = questions.length > 0
    const settled = questions.flatMap((question) => {
      const withdrawn = botItemAskSettled(question.askWhile, now, this.deps.worker)
      return withdrawn ? [{ ...question, withdrawn }] : []
    })
    const refs = settled.flatMap(({ withdrawn }) =>
      withdrawn.kind === 'dispatch' ? [withdrawn.ref] : []
    )
    const titles = refs.length > 0 ? await this.deps.workerTitle(refs) : new Map<string, string>()
    const moved: string[] = []
    for (const { uid, questionEvent, withdrawn } of settled) {
      const title = withdrawn.kind === 'dispatch' ? titles.get(withdrawn.ref) : undefined
      const named = withdrawn.kind === 'dispatch' && title ? { ...withdrawn, title } : withdrawn
      const eventId = await store.withdrawAsk(uid, questionEvent, named, now)
      if (eventId !== null) {
        moved.push(uid)
        this.unsent.set(eventId, MAIL_RETRIES)
      }
    }
    if (moved.length > 0) {
      this.deps.changed((await store.viewRows(moved)).items)
    }
    await this.sendMail(store)
  }

  private async sendMail(store: BotItemAskWithdrawalStore): Promise<void> {
    if (this.unsent.size === 0) {
      return
    }
    await this.deps.sendOwedMail()
    const owed = new Set(await store.stillOwed([...this.unsent.keys()]))
    for (const [eventId, left] of this.unsent) {
      if (!owed.has(eventId) || left <= 1) {
        this.unsent.delete(eventId)
      } else {
        this.unsent.set(eventId, left - 1)
      }
    }
  }
}
