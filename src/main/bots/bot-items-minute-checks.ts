// The items' own moves Orca checks on the scheduler's minute and on item and worker changes: Waiting
// for a usage limit, and Needs you asks whose `--while` settled.
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { BotItemAskWithdrawals, linkedWorkerTitles } from './bot-item-ask-withdrawals'
import { botItemAskWhileWorker } from './bot-item-ask-while-worker'
import { BotItemUsageLimitWaits } from './bot-item-usage-limit-wait'
import type { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemRecord } from './bot-items-schema'

export type BotItemMinuteCheckDeps = {
  /** The profile's items store, only once it has a file. */
  openedStore: () => BotItemsRemote | null
  sendOwedMail: () => Promise<void>
  join: BotItemLinkJoin
  db: () => OrchestrationDb | null | undefined
  /** A chat session's lineage root. */
  chatRoot: (sessionId: string) => string
  /** Items Orca moved. */
  changed: (items: readonly BotItemRecord[]) => void
}

export class BotItemMinuteChecks {
  private readonly usageLimitWaits: BotItemUsageLimitWaits
  private readonly askWithdrawals: BotItemAskWithdrawals

  constructor(deps: BotItemMinuteCheckDeps) {
    const { db, chatRoot } = deps
    this.usageLimitWaits = new BotItemUsageLimitWaits({
      store: deps.openedStore,
      join: deps.join,
      sessionOf: (dispatchId) => {
        const session = db()?.getDispatchContextById(dispatchId)?.assignee_orca_session_id
        return session ? chatRoot(session) : null
      },
      root: chatRoot,
      changed: deps.changed
    })
    this.askWithdrawals = new BotItemAskWithdrawals({
      store: deps.openedStore,
      worker: (ref) => botItemAskWhileWorker(db(), ref),
      workerTitle: linkedWorkerTitles(deps.join),
      changed: deps.changed,
      sendOwedMail: deps.sendOwedMail
    })
  }

  /** With items to move: workers stopping on a usage limit move theirs to Waiting. */
  start(): void {
    this.usageLimitWaits.start()
  }

  stop(): void {
    this.usageLimitWaits.stop()
  }

  /** After startup recovery: an ask whose worker ended or time passed while Orca was closed. */
  recovered(): void {
    this.askWithdrawals.tick()
  }

  /** Items changed: a stopped worker's item may now wait, and an item may now ask `--while`. */
  itemsChanged(): void {
    this.usageLimitWaits.recheck()
    this.askWithdrawals.itemsChanged()
  }

  /** A worker finished: it can leave only stopped ones on its item. */
  workerChanged(): void {
    this.usageLimitWaits.recheck()
  }

  /** The scheduler's minute: a usage-limit stop whose time passed unannounced ends, and an ask whose
   *  `--while` settled is withdrawn. */
  tick(now: number): void {
    this.usageLimitWaits.tick(now)
    this.askWithdrawals.tick(now)
  }
}
