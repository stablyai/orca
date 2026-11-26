// Bot items as this host serves them: the store per profile (its SQL in the bots DB worker), items as
// the wire shows them (reads never write; worker and PR state come live from their own records), and
// workers started for an item linked from orchestration's record. Changes owed to an item's chat go out
// as orchestration mail; startup sends any a crash left owed.
import type { Bot } from '../../shared/bot-types'
import { botItemEventId, type BotItem, type BotItemEvent } from '../../shared/bots/bot-items'
import { botItemsNeedingOwnerByBot } from '../../shared/bots/bot-item-groups'
import { botItemQuestionView } from '../../shared/bots/bot-item-ask'
import {
  botItemsChangeScope,
  type BotChangeScope,
  type BotNeedsYouCounts
} from '../../shared/bots/bot-change-scope'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { access } from 'node:fs/promises'
import { BotItemWorkerLinks } from './bot-item-worker-links'
import { trackDispatchLinks, type TrackedBotItems } from './bot-item-dispatch-link-refs'
import { dispatchStarter, dispatchStarterBotId } from './bot-item-dispatch-facts'
import { botItemsStoreFile } from './bot-items-input'
import {
  BotItemLinkJoin,
  type BotItemAutomations,
  type BotItemGitHubCache
} from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import { eventViewOf } from './bot-items-rows'
import type { BotItemMail, BotItemRecord, BotItemSource } from './bot-items-schema'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'
import { BotItemUsageLimitWaits } from './bot-item-usage-limit-wait'

export type BotItemsHostDeps = {
  workRuntime: BotWorkRuntime
  /** The bots DB worker the store's SQL runs in. */
  db: Pick<BotsDbWorkerClient, 'items' | 'dispose'>
  bots: () => readonly Bot[]
  /** The host's GitHub PR and issue caches: the desktop's, read on use, never a GitHub call. */
  githubCache: BotItemGitHubCache
  automations: BotItemAutomations
  chatTitle: (chatId: string) => string | null
  /** False only when the chat records were read and this chat's is gone; unread is not gone. */
  chatExists: (chatId: string) => boolean
  /** A chat's lineage root: the id `bot chats` lists, which a /clear keeps. */
  chatRoot: (sessionId: string) => string
  /** Connector threads' chats, by the session each link names. */
  threadChats: () => readonly { sessionId: string; title: string | null }[]
  /** Automation runs' chats. */
  automationRunChats: () => readonly string[]
  notify: (scope: BotChangeScope) => void
  /** Stores a write's mail for its items' chat; true once nothing is owed. */
  sendMail: (mail: BotItemMail) => Promise<boolean>
}

export class BotItemsHost {
  private readonly stores = new Map<string, TrackedBotItems>()
  private readonly join: BotItemLinkJoin
  private readonly workerLinks: BotItemWorkerLinks
  private mailing: Promise<void> | null = null
  private readonly usageLimitWaits: BotItemUsageLimitWaits
  private mailAgain = false

  constructor(private readonly deps: BotItemsHostDeps) {
    this.join = new BotItemLinkJoin(deps.workRuntime, deps.githubCache, deps.automations)
    const db = () => deps.workRuntime.getOrchestrationDb()
    this.workerLinks = new BotItemWorkerLinks({
      store: () => this.openedTracked(),
      db,
      starter: (dispatchId) => dispatchStarter(db(), dispatchId, deps.chatRoot),
      starterBotId: (dispatchId) => dispatchStarterBotId(db(), dispatchId, deps.bots()),
      linksOf: async (item) => (await this.views([item]))[0]?.links,
      sendOwedMail: () => this.sendOwedMail(),
      changed: (store, uids) => this.changedItems(store, uids),
      warn
    })
    this.usageLimitWaits = new BotItemUsageLimitWaits({
      store: () => this.openedStore(),
      join: this.join,
      sessionOf: (dispatchId) => {
        const session = db()?.getDispatchContextById(dispatchId)?.assignee_orca_session_id
        return session ? deps.chatRoot(session) : null
      },
      root: deps.chatRoot,
      changed: (items) => this.notifyChanged(items)
    })
  }

  /** Per profile: a profile switch reads that profile's items. */
  store(): BotItemsRemote {
    const path = botItemsStoreFile(getProfileUserDataPath())
    let store = this.stores.get(path)
    if (!store) {
      store = trackDispatchLinks((around) => this.deps.db.items(path, around))
      this.stores.set(path, store)
      // With items to move: workers stopping on a usage limit move theirs to Waiting.
      this.usageLimitWaits.start()
    }
    return store.remote
  }

  /** The store only when this profile already has an items file: nothing links work before one. */
  private openedStore(): BotItemsRemote | null {
    return this.openedTracked()?.remote ?? null
  }

  private openedTracked(): TrackedBotItems | null {
    return this.stores.get(botItemsStoreFile(getProfileUserDataPath())) ?? null
  }

  async owedCommentAttachmentUploads(
    stateDirectory: string,
    root: string
  ): Promise<ReadonlySet<string>> {
    const tracked = this.stores.get(botItemsStoreFile(stateDirectory))
    return new Set(await tracked?.remote.owedCommentAttachmentUploads(root))
  }

  /** Once the runtime has its bot hooks: an existing items file sends what a crash left owed and
   *  catches up worker and PR evidence, scheduler or not. */
  startRecovery(): void {
    void this.recover().catch(warn)
  }

  private async recover(): Promise<void> {
    const path = botItemsStoreFile(getProfileUserDataPath())
    if (!this.stores.has(path)) {
      const exists = await access(path).then(
        () => true,
        () => false
      )
      if (!exists) {
        return
      }
      this.store()
    }
    await this.sendOwedMail()
  }

  /** Leaves the bots DB worker client alone: the runtime owns it, shared with the work record. */
  dispose(): void {
    this.usageLimitWaits.stop()
    this.stores.clear()
  }

  /** Where a chat came from: the bot's Home Chat, a connector thread, an automation run, a side chat. */
  chatSource(
    bot: Pick<Bot, 'chatSessionId'>,
    chatId: string,
    root: (id: string) => string,
    title: string | null
  ): BotItemSource {
    if (bot.chatSessionId && root(bot.chatSessionId) === chatId) {
      return { kind: 'home', title: 'Home Chat' }
    }
    const thread = this.deps.threadChats().find((entry) => root(entry.sessionId) === chatId)
    if (thread) {
      return { kind: 'thread', title: thread.title || title }
    }
    if (this.deps.automationRunChats().some((sessionId) => root(sessionId) === chatId)) {
      return { kind: 'automation', title }
    }
    return { kind: 'chat', title }
  }

  chatRootOf(sessionId: string): string {
    return this.deps.chatRoot(sessionId)
  }

  chatTitleOf(chatId: string): string | null {
    return this.deps.chatTitle(chatId)
  }

  /** The chat that owns an item, as the item view shows it. */
  owningChat({ chatId: id, source }: Pick<BotItemRecord, 'chatId' | 'source'>): BotItem['chat'] {
    const gone = this.deps.chatExists(id) ? {} : { gone: true as const }
    return { id, kind: source.kind, title: this.deps.chatTitle(id) ?? source.title, ...gone }
  }

  /** These items changed: their bots' lists re-read just them, and one that is now In progress with
   *  a worker already stopped on its usage limit waits. */
  changed(items: readonly Pick<BotItemRecord, 'uid' | 'ownerBotId'>[]): void {
    this.notifyChanged(items)
    if (items.length > 0) {
      this.usageLimitWaits.recheck()
    }
  }

  private notifyChanged(items: readonly Pick<BotItemRecord, 'uid' | 'ownerBotId'>[]): void {
    const scope = botItemsChangeScope(items)
    if (scope) {
      this.deps.notify(scope)
    }
  }

  /** The scheduler's minute: a usage-limit stop whose time passed unannounced ends. */
  usageLimitTick(now: number): void {
    this.usageLimitWaits.tick(now)
  }

  /** Mail every change still owed. One pass at a time; a call during one makes it run again,
   *  so a change written meanwhile is not left owed. */
  async sendOwedMail(): Promise<void> {
    const store = this.openedStore()
    if (!store) {
      return
    }
    this.mailAgain = true
    this.mailing ??= (async () => {
      while (this.mailAgain) {
        this.mailAgain = false
        await this.sendOwedOnce(store)
      }
    })().finally(() => {
      this.mailing = null
    })
    return this.mailing
  }

  /** Every page, moving past a mail that fails so the rest still go. */
  private async sendOwedOnce(store: BotItemsRemote): Promise<void> {
    let after = 0
    for (;;) {
      const { mails, through } = await store.owedMail(after)
      if (through === null) {
        return
      }
      const sent: number[] = []
      for (const mail of mails) {
        try {
          if (await this.deps.sendMail(mail)) {
            sent.push(...mail.changes.map(({ event }) => event.id))
          }
        } catch (error) {
          // Left owed: the next write or startup sends it under the same id.
          warn(error)
        }
      }
      if (sent.length > 0) {
        await store.markMailSent(sent)
      }
      after = through
    }
  }

  /** Each bot's unstale Needs you items, counted at `now`; null when unreadable, never a false zero. */
  async needsYouCounts(now: number): Promise<BotNeedsYouCounts | null> {
    const store = this.openedStore()
    const rows = store ? await store.needsYou().catch(warn) : []
    return rows && { ...botItemsNeedingOwnerByBot(rows, this.deps.bots(), now), at: now }
  }

  /** Items as the wire shows them, links joined in one batch; `summary` leaves out the long texts a
   *  list doesn't show. */
  async views(
    items: readonly BotItemRecord[],
    summary = false,
    /** Each Needs you item's waiting ask too: for the item's own view. */
    withWaitingAsks = false
  ): Promise<BotItem[]> {
    if (items.length === 0) {
      return []
    }
    const rows = await this.store().viewRows(
      items.map((item) => item.uid),
      withWaitingAsks
    )
    const refs = Object.values(rows.links)
      .flat()
      .flatMap((link) => (link.kind === 'dispatch' ? [link.ref] : []))
    const workers = await this.join.readLinkedWorkers(refs)
    const byUid = new Map(rows.items.map((item) => [item.uid, item]))
    const bots = this.deps.bots()
    const nameOf = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? null
    return items.map((given): BotItem => {
      const item = byUid.get(given.uid) ?? given
      const question = rows.questions[item.uid]
      const wait = rows.waits[item.uid]
      const waitText = typeof wait?.data.note === 'string' ? wait.data.note : null
      const { madeBy } = item
      return {
        uid: item.uid,
        number: item.number,
        owner: { botId: item.ownerBotId, name: nameOf(item.ownerBotId) },
        title: item.title,
        description: summary ? null : item.description,
        doneMeans: summary ? null : item.doneMeans,
        status: item.status,
        chat: this.owningChat(item),
        madeBy: madeBy
          ? { botId: madeBy.botId, name: nameOf(madeBy.botId), chatId: madeBy.chatId }
          : null,
        question: question ? botItemQuestionView(botItemEventId(question.id), question.data) : null,
        ...(rows.waitingAsks[item.uid] ? { waitingAsk: rows.waitingAsks[item.uid] } : {}),
        closeNote: summary ? null : item.closeNote,
        wait: wait && waitText !== null ? { text: waitText, at: wait.createdAt } : null,
        links: (rows.links[item.uid] ?? []).map((link) =>
          this.join.linkView(link, workers.get(link.ref))
        ),
        version: item.version,
        lastEventId: botItemEventId(item.lastEventId),
        othersLastEventId: botItemEventId(rows.othersLast[item.uid] ?? 0),
        snoozedUntil: item.snoozedUntil,
        lastActivityAt: item.lastActivityAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        closedAt: item.closedAt
      }
    })
  }

  async events(uid: string, afterId: number, limit: number): Promise<BotItemEvent[]> {
    return (await this.store().events(uid, afterId, limit)).map(eventViewOf)
  }

  /** The newest `limit` events before `beforeId` (0: the newest of all), oldest first. */
  async eventsBefore(uid: string, beforeId: number, limit: number): Promise<BotItemEvent[]> {
    return (await this.store().eventsBefore(uid, beforeId, limit)).map(eventViewOf)
  }

  /** A write to any Dispatch's rows (the database's notice), or a paired server's verdict on one. */
  workersWritten(dispatchIds: readonly string[] = [], deleted = false): void {
    this.join.workersWritten(dispatchIds, deleted)
  }

  /** A Dispatch row changed: a start for an item is linked, and linked items re-read. */
  dispatchChanged(dispatchId: string | null): void {
    if (dispatchId !== null) {
      this.workerLinks.dispatchChanged(dispatchId)
      // A worker that finished can leave only stopped ones on its item.
      this.usageLimitWaits.recheck()
    }
  }

  private async changedItems(store: BotItemsRemote, uids: readonly string[]): Promise<void> {
    if (uids.length === 0) {
      return
    }
    const rows = await store.viewRows([...new Set(uids)])
    this.changed(rows.items)
  }
}

/** Null so a failed read can `.catch(warn)` to "unknown". */
export function warn(error: unknown): null {
  console.warn('[bots] items', error)
  return null
}
