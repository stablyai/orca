import { structuredAgentSessionIdOfTab } from '../../shared/agent-session/view/structured-agent-session-tab'
import {
  addBotChange,
  botChangeNotice,
  type BotChangeKind,
  type PendingBotChanges,
  type BotChangeScope,
  type BotNeedsYouCounts
} from '../../shared/bots/bot-change-scope'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'

// `botsChanged` goes out on the next tick after a change, so an owner's click shows at once; later
// changes in the following quiet window go out together at its end, instead of one notice each. Each
// notice says which bots and which kinds of change it covers, so a reader of another bot skips it.

const BOT_CHANGE_NOTICE_DELAY_MS = 500

export type BotChangeNoticeDeps = {
  emit: (scope: BotChangeScope) => void
  /** A host without bots has no reader for the notice. */
  hasBots: () => boolean
  /** Counted for a notice that may move them, so no window re-reads the bot list for its badges; null
   *  when they can't be read. */
  needsYouCounts?: () => Promise<BotNeedsYouCounts | null>
  delayMs?: number
}

export class BotChangeNotices {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The changes no notice has covered yet, each kind with its own bots. */
  private pending: PendingBotChanges | null = null
  /** The last notice still waiting on its count: notices leave in order behind it. */
  private sending: Promise<void> | null = null

  constructor(private readonly deps: BotChangeNoticeDeps) {}

  /** A bot, its automations or the work that feeds its Activity may have changed: these bots (all
   *  when unnamed), and this kind of change (any when unnamed). */
  changed(scope: BotChangeScope = {}): void {
    if (!this.deps.hasBots()) {
      return
    }
    this.pending ??= new Map()
    addBotChange(this.pending, scope)
    if (!this.timer) {
      // The next tick, so one call's several writes go out as one notice.
      this.wait(0)
    }
  }

  private wait(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      const pending = this.pending
      if (pending) {
        this.pending = null
        this.send(botChangeNotice(pending))
        this.wait(this.deps.delayMs ?? BOT_CHANGE_NOTICE_DELAY_MS)
      }
    }, ms)
    this.timer.unref?.()
  }

  private send(scope: BotChangeScope): void {
    const count = this.deps.needsYouCounts
    // An unscoped notice re-reads the whole list anyway. A failed count sends the notice bare, and
    // its readers read the list instead.
    const counted = count && scope.kinds?.includes('items') ? count().catch(() => null) : undefined
    if (!counted && !this.sending) {
      this.deps.emit(scope)
      return
    }
    const sending: Promise<void> = (this.sending ?? Promise.resolve())
      .then(() => counted)
      .then((needsYou) => this.deps.emit(needsYou ? { ...scope, needsYou } : scope))
      .catch((error: unknown) => console.warn('[bots] sending a change notice failed', error))
      .finally(() => {
        if (this.sending === sending) {
          this.sending = null
        }
      })
    this.sending = sending
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}

type AgentPhaseChange = { kind: string; paneKey: string; workspace: { worktreeId: string } | null }

/** Which bot a pane works for, as the host can tell. */
export type BotPaneFacts = {
  /** The bot whose home `worktreeId` is, or whose home a worktree sits under (its agents work for it). */
  botOfWorkspace: (worktreeId: string) => string | null
  /** The bot whose chat, worker or run a pane is. */
  botOfPane: (paneKey: string) => string | null
  /** Whether the pane is a member's in a bot group room. */
  inGroupRoom: (sessionId: string) => boolean
  /** A Dispatch's worker pane. */
  workerPane: (paneKey: string) => boolean
  /** Reads the chats of bots never read yet; false when one can't be read, so a worker pane may be an
   *  unread bot's. */
  readEveryBot: () => boolean
}

/** The notices one phase change makes: its bot's (a chat's status, a worker's), its group room's.
 *  None for a pane no bot or group shows, such as a chat or terminal agent outside every bot home.
 *  A worker's phase is its worker's state too, so readers of workers (items) re-read for it. */
export function botPhaseChangeScopes(
  change: AgentPhaseChange,
  facts: BotPaneFacts
): BotChangeScope[] {
  const scopes: BotChangeScope[] = []
  const worktreeId = change.workspace?.worktreeId
  const find = (): string | null =>
    (worktreeId ? facts.botOfWorkspace(worktreeId) : null) ?? facts.botOfPane(change.paneKey)
  const worker = facts.workerPane(change.paneKey)
  const kinds: BotChangeKind[] = worker ? ['status', 'workers'] : ['status']
  // A worker no read bot claims may be a never-read bot's: read those once, then look again.
  let botId = find()
  let everyBotRead = true
  if (!botId && worker) {
    everyBotRead = facts.readEveryBot()
    botId = everyBotRead ? find() : null
  }
  if (botId) {
    scopes.push({ botIds: [botId], kinds })
  } else if (!everyBotRead) {
    // It may be an unread bot's worker: every bot's readers hear of it.
    scopes.push({ kinds })
  }
  const tabId = parsePaneKey(change.paneKey)?.tabId
  const sessionId = tabId ? structuredAgentSessionIdOfTab(tabId) : null
  if (sessionId && facts.inGroupRoom(sessionId)) {
    scopes.push({ kinds: ['groups'] })
  }
  return scopes
}

/** A phase change (working, needs you, done) of a pane a bot or group shows; per-tick observations are
 *  not. The detector follows the host's one agent-status store. */
export function followAgentPhasesForBots(
  transitions: { subscribe: (listener: (change: AgentPhaseChange) => void) => () => void },
  notices: Pick<BotChangeNotices, 'changed'>,
  facts: BotPaneFacts & { hasBots: () => boolean }
): () => void {
  return transitions.subscribe((change) => {
    if (change.kind !== 'observed' && facts.hasBots()) {
      for (const scope of botPhaseChangeScopes(change, facts)) {
        notices.changed(scope)
      }
    }
  })
}

/** A worker's new worktree, made with its lineage at the point the list hears worktreesChanged, is a
 *  bot's new worker row; a removed one leaves its Activity. Only the bots it concerns hear of it. */
export function followWorktreeLifecycleForBots(
  onWorktreeLifecycle: (listener: (event: { worktreeId: string }) => void) => () => void,
  notices: Pick<BotChangeNotices, 'changed'>,
  scopeOf: (worktreeId: string) => BotChangeScope | null
): () => void {
  return onWorktreeLifecycle((event) => {
    const scope = scopeOf(event.worktreeId)
    if (scope) {
      notices.changed(scope)
    }
  })
}
