// Orca withdrawing Needs you asks whose `--while` settled: the worker they name ended, or their time
// passed. Checked on the scheduler's minute (and once at startup), so a withdrawal lands within a minute.
import type { BotItemAskWhile, BotItemAskWithdrawn } from '../../shared/bots/bot-item-ask-while'
import type { BotItemAskWhileWorker } from './bot-item-ask-while-worker'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemRecord } from './bot-items-schema'

export type BotItemAskWithdrawalStore = Pick<
  BotItemsRemote,
  'askWhileQuestions' | 'withdrawAsk' | 'stillOwed' | 'owedWithdrawals' | 'viewRows'
>

export type BotItemAskWithdrawalDeps = {
  /** The profile's items store, only once it has a file. */
  store: () => BotItemAskWithdrawalStore | null
  /** How the worker a `dispatch:` ask names stands now. */
  worker: (ref: string) => BotItemAskWhileWorker
  /** Workers' titles as their items show them, by ref; a ref with none is left out. */
  workerTitle: (refs: readonly string[]) => Promise<ReadonlyMap<string, string>>
  /** Items Orca moved. */
  changed: (items: readonly BotItemRecord[]) => void
  sendOwedMail: () => Promise<void>
}

/** Workers' titles as their items show them, from the item link join. */
export function linkedWorkerTitles(
  join: Pick<BotItemLinkJoin, 'readLinkedWorkers'>
): BotItemAskWithdrawalDeps['workerTitle'] {
  return async (refs) => {
    const workers = await join.readLinkedWorkers(refs, { pullRequests: false })
    return new Map(
      [...workers].flatMap(([ref, read]) => (read.worker?.title ? [[ref, read.worker.title]] : []))
    )
  }
}

/** A withdrawal's mail is tried again each minute for up to an hour, then left to the next write. */
const MAIL_RETRIES = 60

/** Why the ask is no longer needed, or null while it still is (or that can't be told). */
function settledBy(
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

/** One pass at a time; a minute during one runs it again with that minute's time. A failed pass is
 *  tried at the next minute. */
export class BotItemAskWithdrawals {
  private running: Promise<void> | null = null
  private latest: number | null = null
  /** Withdrawals whose mail is still owed, with the minutes of retries left. */
  private readonly unsent = new Map<number, number>()
  /** Owed withdrawals a crash left are picked up by the first pass. */
  private seeded = false
  /** Whether any `--while` ask was open at the last pass; none, and a minute costs nothing. */
  private armed = true
  /** Items moved whose lists weren't told yet (a later write in the pass failed). */
  private readonly untold = new Set<string>()
  /** The profile's store all of the above belongs to; another profile starts over. */
  private store: BotItemAskWithdrawalStore | null = null

  constructor(private readonly deps: BotItemAskWithdrawalDeps) {}

  tick(now = Date.now()): void {
    const store = this.deps.store()
    if (store !== this.store) {
      this.store = store
      this.unsent.clear()
      this.untold.clear()
      this.seeded = false
      this.armed = true
    }
    if (!this.armed && this.unsent.size === 0 && this.untold.size === 0 && this.seeded) {
      return
    }
    this.latest = now
    this.running ??= (async () => {
      while (this.latest !== null) {
        const at = this.latest
        this.latest = null
        await this.pass(at).catch((error: unknown) => {
          this.armed = true
          console.warn('[bots] items: withdrawing settled asks failed', error)
        })
      }
    })().finally(() => {
      this.running = null
    })
  }

  /** An item changed: it may now ask `--while`, which the next minute checks. */
  itemsChanged(): void {
    this.armed = true
  }

  async settled(): Promise<void> {
    await this.running
  }

  private async pass(now: number): Promise<void> {
    // One store for the whole pass: a profile switch meanwhile leaves the new profile to its own pass.
    const store = this.store
    if (!store) {
      return
    }
    if (!this.seeded) {
      for (const eventId of await store.owedWithdrawals()) {
        this.unsent.set(eventId, MAIL_RETRIES)
      }
      this.seeded = true
    }
    const questions = await store.askWhileQuestions()
    this.armed = questions.length > 0
    const candidates = questions.filter(
      (question) => settledBy(question.askWhile, now, this.deps.worker) !== null
    )
    const refs = candidates.flatMap(({ askWhile }) =>
      askWhile.kind === 'dispatch' ? [askWhile.ref] : []
    )
    const titles = refs.length > 0 ? await this.deps.workerTitle(refs) : new Map<string, string>()
    for (const { uid, questionEvent, askWhile } of candidates) {
      // Read again after the titles' wait, right before the write.
      const withdrawn = settledBy(askWhile, now, this.deps.worker)
      if (!withdrawn) {
        continue
      }
      const title = withdrawn.kind === 'dispatch' ? titles.get(withdrawn.ref) : undefined
      const named = withdrawn.kind === 'dispatch' && title ? { ...withdrawn, title } : withdrawn
      const eventId = await store.withdrawAsk(uid, questionEvent, named, now)
      if (eventId !== null) {
        this.untold.add(uid)
        this.unsent.set(eventId, MAIL_RETRIES)
      }
    }
    if (this.untold.size > 0) {
      const moved = [...this.untold]
      this.deps.changed((await store.viewRows(moved)).items)
      moved.forEach((uid) => this.untold.delete(uid))
    }
    await this.sendMail(store)
  }

  /** Once per pass, so once a minute: each owed withdrawal spends one retry. */
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
