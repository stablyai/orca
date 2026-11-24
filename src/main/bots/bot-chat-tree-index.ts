// Each bot's chats-tree base, kept between reads and changed in place from the record store's commits
// and the orchestration database's Dispatch changes, so a read costs that bot's chats, not every record
// on the host. It also names the bot each change concerns, for per-bot `botsChanged` notices.
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { structuredAgentSessionIdOfTab } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { Bot } from '../../shared/bot-types'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'
import type { BotBackgroundRuns } from './bot-background-run-records'
import {
  botChatInputsKey,
  buildBotChatBase,
  comparableBotChatBase,
  type BotChatBaseBuild,
  type BotChatInputs
} from './bot-chat-tree-base'
import { BotChatTreeFullChecks } from './bot-chat-tree-full-checks'
import {
  botChatTreeRecordShowsNew,
  botChatTreeTabsMoved,
  botChatTreeStampsMissed,
  indexBotChatTreeCreators,
  newBotChatTreeEntry,
  refreshBotChatTreeSessions,
  type BotChatTreeEntry
} from './bot-chat-tree-entry'
import { BotHomeRecords, type RecordWorkspaceChange } from './bot-home-records'
import { BotDispatchChanges } from './bot-dispatch-changes'

export type BotChatTreeIndexDeps = {
  bots: () => readonly Bot[]
  records: () => AgentSessionRecordReader | null
  db: () => OrchestrationDb
  backgroundRuns: BotBackgroundRuns
  inputs: (bot: Bot) => BotChatInputs
  /** A change the index tied to bots; the host sends it as a notice. */
  changed: (scope: BotChangeScope) => void
  /** Whether the host is quiet (nothing streaming), so a full check can run. */
  idle?: () => boolean
  now?: () => number
}

export class BotChatTreeIndex {
  private readonly entries = new Map<string, BotChatTreeEntry>()
  private readonly records = new BotHomeRecords((changes, tabsChanged) =>
    this.recordsChanged(changes, tabsChanged)
  )
  private readonly fullChecks: BotChatTreeFullChecks
  private db: OrchestrationDb | null = null
  private readonly dispatchChanges = new BotDispatchChanges({
    db: () => this.deps.db(),
    placements: () =>
      [...this.entries].map(([botId, entry]) => [botId, entry.build.placement] as const),
    applied: (botIds, unplaced) => this.dispatchesApplied(botIds, unplaced),
    removed: () => this.dispatchesRemoved(),
    unreadable: () => this.dispatchesRemoved()
  })
  /** Drift found by a check: a missed commit or Dispatch change. Read by tests and the bench. */
  readonly drift = { count: 0, fullChecks: 0, fullCheckMs: 0, cheapCheckMs: 0 }

  constructor(private readonly deps: BotChatTreeIndexDeps) {
    this.fullChecks = new BotChatTreeFullChecks({
      ...(deps.idle ? { idle: deps.idle } : {}),
      now: () => deps.now?.() ?? Date.now(),
      verify: (botId) => this.verify(botId).ms
    })
  }

  private tell(scope: BotChangeScope): void {
    this.fullChecks.noteChange()
    this.deps.changed(scope)
  }

  /** The bot's base, brought up to date; built from its home's records only. */
  base(bot: Bot, inputs = this.deps.inputs(bot)): BotChatBaseBuild {
    const reader = this.deps.records()
    const followed = this.records.follow(reader)
    if (followed === 'seeded') {
      this.swapped()
    } else if (followed === 'unfollowable') {
      // No commit is ever heard from such a reader: each read builds from it whole, as before the index.
      this.markAllFull()
    }
    const db = this.deps.db()
    if (this.db !== db) {
      if (this.db) {
        this.swapped()
      }
      this.db = db
      this.markAllFull()
    }
    this.prune()
    const entry = this.entries.get(bot.id)
    if (!entry || entry.full || entry.build.inputsKey !== botChatInputsKey(inputs)) {
      return this.rebuild(bot, inputs, reader).build
    }
    const started = performance.now()
    const missed = reader ? this.cheapCheck(entry, reader) : null
    this.drift.cheapCheckMs += performance.now() - started
    if (missed) {
      this.noteDrift(bot.id, missed)
      return this.rebuild(bot, inputs, reader).build
    }
    if (
      reader &&
      entry.dirtySessions.size > 0 &&
      !refreshBotChatTreeSessions(this.context(), bot, entry, reader, this.records)
    ) {
      return this.rebuild(bot, inputs, reader).build
    }
    return entry.build
  }

  private rebuild(bot: Bot, inputs: BotChatInputs, reader: AgentSessionRecordReader | null) {
    const records = this.homeRecords(bot, reader)
    const entry = newBotChatTreeEntry(
      buildBotChatBase(this.context(), reader, inputs, records),
      records,
      reader,
      this.records
    )
    this.entries.set(bot.id, entry)
    this.fullChecks.track(bot.id)
    return entry
  }

  private context() {
    return { db: this.deps.db(), backgroundRuns: this.deps.backgroundRuns }
  }

  private homeRecords(
    bot: Bot,
    reader: AgentSessionRecordReader | null
  ): AgentSessionConversationView[] {
    if (!reader) {
      return []
    }
    if (!this.records.following) {
      // A reader that can't say its commits is read whole, as before the index.
      return reader.listRecords()
    }
    return [...this.records.idsIn(folderWorkspaceKey(bot.folderWorkspaceId))].flatMap((id) => {
      const record = reader.getRecord(id)
      return record ? [record] : []
    })
  }

  /** O(the bot's chats): no commit went unheard by the store's own counts, and each home record is the
   *  row the index last read. Returns what it missed, if anything. */
  private cheapCheck(entry: BotChatTreeEntry, reader: AgentSessionRecordReader): string | null {
    const missed = this.records.missed(reader)
    if (missed) {
      this.records.seed(reader)
      this.swapped()
      return missed
    }
    return botChatTreeStampsMissed(entry, reader, this.records) ? 'record' : null
  }

  private prune(): void {
    const ids = new Set(this.deps.bots().map((bot) => bot.id))
    for (const id of this.entries.keys()) {
      if (!ids.has(id)) {
        this.entries.delete(id)
        this.fullChecks.forget(id)
      }
    }
  }

  /** A store opened again or a database swapped: every base rebuilds, and every bot is due a full check. */
  private swapped(): void {
    this.markAllFull()
    this.fullChecks.dueAll()
  }

  private markAllFull(): void {
    for (const entry of this.entries.values()) {
      entry.full = true
    }
  }

  private noteDrift(botId: string, what: string): void {
    this.drift.count += 1
    console.warn(`[bots] chat-tree index drift for ${botId}: ${what}; rebuilt`)
  }

  private botOfHomeMap(): Map<string, string> {
    return new Map(
      this.deps.bots().map((bot) => [folderWorkspaceKey(bot.folderWorkspaceId), bot.id])
    )
  }

  /** The store committed these records: each bot whose home they were or are in hears of it. */
  private recordsChanged(changes: readonly RecordWorkspaceChange[], tabsChanged: boolean): void {
    const reader = this.deps.records()
    // A tab commit names no session: only the bots whose kept chats' tabs closed or reopened hear it.
    const touched = new Set(tabsChanged ? botChatTreeTabsMoved(this.entries, reader) : [])
    const botOfHome = this.botOfHomeMap()
    for (const { sessionId, before, after } of changes) {
      for (const workspace of new Set([before, after])) {
        const botId = workspace === undefined ? undefined : botOfHome.get(workspace)
        const entry = botId ? this.entries.get(botId) : undefined
        if (!botId) {
          continue
        }
        if (entry && before !== after) {
          entry.full = true
        } else if (
          entry &&
          reader &&
          !botChatTreeRecordShowsNew(entry, sessionId, reader, this.records)
        ) {
          // A lease renewal or another write no chat row shows.
          continue
        } else {
          entry?.dirtySessions.add(sessionId)
        }
        touched.add(botId)
      }
    }
    if (touched.size > 0) {
      this.tell({ botIds: [...touched], kinds: ['chats'] })
    }
  }

  /** A Dispatch row changed (any writer, through the database's own trigger): told to the bots whose
   *  chats or workers it belongs to once the write's transaction ends. */
  dispatchLinkChanged(dispatchId: string | null, change: DispatchRowChange = 'written'): void {
    this.dispatchChanges.changed(dispatchId, change)
  }

  /** Dispatches were deleted (an orchestration reset): every base rebuilds, and every bot hears. */
  private dispatchesRemoved(): void {
    this.markAllFull()
    this.tell({ kinds: ['workers'] })
  }

  private dispatchesApplied(botIds: ReadonlySet<string>, unplaced: readonly string[]): void {
    for (const botId of botIds) {
      const entry = this.entries.get(botId)
      if (entry) {
        indexBotChatTreeCreators(entry)
      }
    }
    // A Dispatch no kept bot places may be a never-read bot's.
    const owners = unplaced.length > 0 ? this.ownersOf(unplaced, true) : []
    if (owners === null) {
      this.tell({ kinds: ['workers'] })
    } else if (botIds.size > 0 || owners.length > 0) {
      this.tell({ botIds: [...new Set([...botIds, ...owners])], kinds: ['workers'] })
    }
  }

  /** The bot whose chat, worker or run this session is; null for none the index knows. */
  botOfSession(sessionId: string): string | null {
    const workspace =
      this.records.workspaceOfSession(sessionId) ??
      this.deps.records()?.getRecord(sessionId)?.location.workspaceId
    const home = workspace ? this.botOfHomeMap().get(workspace) : undefined
    return home ?? this.find((entry) => entry.creatorSessions.has(sessionId))
  }

  /** The bot a pane works for: its chat's, or one of its workers' or runs' panes. */
  botOfPane(paneKey: string): string | null {
    const tabId = parsePaneKey(paneKey)?.tabId
    const sessionId = tabId ? structuredAgentSessionIdOfTab(tabId) : null
    return (
      (sessionId ? this.botOfSession(sessionId) : null) ??
      this.find((entry) => entry.creatorPanes.has(paneKey))
    )
  }

  /** The bots these Dispatches are workers of; null when a bot's chats can't be read. */
  ownersOf(dispatchIds: readonly string[], unreadOnly = false): string[] | null {
    const among = this.deps.bots().filter((bot) => !unreadOnly || !this.entries.has(bot.id))
    const placed = ({ id }: Bot) =>
      dispatchIds.some((d) => this.entries.get(id)?.build.placement.has(d))
    return this.readEveryBot() ? among.filter(placed).map(({ id }) => id) : null
  }

  botOfDispatch(dispatchId: string): string | null {
    return this.find((entry) => entry.build.placement.has(dispatchId))
  }

  botOfWorktree(worktreeId: string): string | null {
    return this.find((entry) => entry.worktrees.has(worktreeId))
  }

  private find(test: (entry: BotChatTreeEntry) => boolean): string | null {
    for (const [botId, entry] of this.entries) {
      if (test(entry)) {
        return botId
      }
    }
    return null
  }

  /** Reads never-read bots' bases once from their homes' records. False when one can't be read, or
   *  before the record store opens (a base would read no chats and hide every owner). */
  readEveryBot(): boolean {
    if (!this.deps.records()) {
      return false
    }
    try {
      this.deps.bots().forEach((bot) => this.entries.get(bot.id) ?? this.base(bot))
      return true
    } catch (error) {
      console.warn("[bots] could not read a bot's chats", error)
      return false
    }
  }

  /** Look around or Tidy-up marked a run: which chats are runs, not chats, may have changed. */
  lookAroundChanged(): void {
    this.markAllFull()
  }

  /** The bot's base against one built from every record on the host. Drift replaces the base. */
  verify(botId: string): { drift: boolean; ms: number } {
    const bot = this.deps.bots().find((entry) => entry.id === botId)
    if (!bot) {
      return { drift: false, ms: 0 }
    }
    const started = performance.now()
    const inputs = this.deps.inputs(bot)
    const kept = this.base(bot, inputs)
    const reader = this.deps.records()
    const full = buildBotChatBase(this.context(), reader, inputs, reader?.listRecords() ?? [])
    const drift = comparableBotChatBase(kept) !== comparableBotChatBase(full)
    const entry = this.entries.get(botId)
    if (drift && entry) {
      this.noteDrift(botId, 'full check')
      entry.full = true
      // No read is waiting on a full check: the bot's readers must hear to see the corrected base.
      this.tell({ botIds: [botId], kinds: ['chats', 'workers'] })
    }
    const ms = performance.now() - started
    this.drift.fullChecks += 1
    this.drift.fullCheckMs += ms
    return { drift, ms }
  }

  dispose(): void {
    this.records.stop()
    this.fullChecks.dispose()
    this.entries.clear()
  }
}

export function createBotChatTreeIndex(deps: BotChatTreeIndexDeps): BotChatTreeIndex {
  return new BotChatTreeIndex(deps)
}
