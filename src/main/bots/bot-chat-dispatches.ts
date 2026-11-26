// Follows a bot's Dispatches from the chats that started them through the workers they started in turn.
import type { BotChatTreeDispatch } from '../../shared/bots/bot-chat-tree-model'
import type { DispatchCreatorLink } from '../runtime/orchestration/db/dispatch-context/dispatch-links-by-id'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'

/** How deep a worker's own workers are followed back to the chat that started the first. */
const WORKER_CHAIN_MAX_DEPTH = 8

type Creators = { orcaSessionIds: string[]; paneKeys: string[] }

/** Every Dispatch the bot's chats started, and the ones their workers started in turn, each with its
 *  chat; kept so a changed or new Dispatch updates it in place instead of a walk of the whole history. */
export class BotDispatchPlacement {
  private readonly found = new Map<string, { dispatch: BotChatTreeDispatch; depth: number }>()
  // A worker's own session or pane, by the chat its first ancestor credits, and its depth.
  private readonly workerSessions = new Map<string, { chatId: string | null; depth: number }>()
  private readonly workerPanes = new Map<string, { chatId: string | null; depth: number }>()
  private readonly creatorSessions: ReadonlySet<string>
  private readonly creatorPanes: ReadonlySet<string>

  constructor(
    private readonly chatOfSession: (sessionId: string) => string | null,
    private readonly chatOfPaneKey: (paneKey: string) => string | null,
    creators: Creators
  ) {
    this.creatorSessions = new Set(creators.orcaSessionIds)
    this.creatorPanes = new Set(creators.paneKeys)
  }

  /** Walks the history from the bot's chats, breadth first, as deep as a worker chain is followed. */
  walk(db: OrchestrationDb): this {
    this.walkFrom(
      db,
      { orcaSessionIds: [...this.creatorSessions], paneKeys: [...this.creatorPanes] },
      0
    )
    return this
  }

  private walkFrom(db: OrchestrationDb, creators: Creators, fromDepth: number): void {
    let frontier = creators
    for (let depth = fromDepth; depth < WORKER_CHAIN_MAX_DEPTH; depth += 1) {
      const next: Creators = { orcaSessionIds: [], paneKeys: [] }
      for (const link of db.listDispatchLinksCreatedByAny(frontier)) {
        if (this.found.has(link.id)) {
          continue
        }
        this.place(link, depth, this.creditedChat(link, depth), next)
      }
      if (next.orcaSessionIds.length === 0 && next.paneKeys.length === 0) {
        break
      }
      frontier = next
    }
  }

  private place(link: DispatchCreatorLink, depth: number, chatId: string | null, next: Creators) {
    this.found.set(link.id, { dispatch: dispatchOf(link, chatId), depth })
    if (link.assigneeOrcaSessionId && !this.workerSessions.has(link.assigneeOrcaSessionId)) {
      this.workerSessions.set(link.assigneeOrcaSessionId, { chatId, depth: depth + 1 })
      next.orcaSessionIds.push(link.assigneeOrcaSessionId)
    }
    if (link.assigneePaneKey && !this.workerPanes.has(link.assigneePaneKey)) {
      this.workerPanes.set(link.assigneePaneKey, { chatId, depth: depth + 1 })
      next.paneKeys.push(link.assigneePaneKey)
    }
  }

  private creditedChat(link: DispatchCreatorLink, depth: number): string | null {
    const { creatorOrcaSessionId: session, creatorPaneKey: pane } = link
    if (depth === 0) {
      return (
        (session ? this.chatOfSession(session) : null) ?? (pane ? this.chatOfPaneKey(pane) : null)
      )
    }
    return (
      (session ? this.workerSessions.get(session)?.chatId : undefined) ??
      (pane ? this.workerPanes.get(pane)?.chatId : undefined) ??
      null
    )
  }

  /** The depth a Dispatch with this creator sits at under the bot, or null when it is none of the bot's. */
  private depthOf(link: DispatchCreatorLink): number | null {
    const { creatorOrcaSessionId: session, creatorPaneKey: pane } = link
    if ((session && this.creatorSessions.has(session)) || (pane && this.creatorPanes.has(pane))) {
      return 0
    }
    const worker =
      (session ? this.workerSessions.get(session) : undefined) ??
      (pane ? this.workerPanes.get(pane) : undefined)
    return worker && worker.depth < WORKER_CHAIN_MAX_DEPTH ? worker.depth : null
  }

  has(dispatchId: string): boolean {
    return this.found.has(dispatchId)
  }

  /** A Dispatch re-read after a change: a known one takes its new state (and its new worker's
   *  Dispatches), a new one of the bot's joins. `none` when it is none of the bot's; `same` when it
   *  shows nothing new. */
  apply(db: OrchestrationDb, link: DispatchCreatorLink): 'none' | 'same' | 'changed' {
    const known = this.found.get(link.id)
    const depth = known?.depth ?? this.depthOf(link)
    if (depth === null) {
      return 'none'
    }
    const chatId = known ? known.dispatch.chatId : this.creditedChat(link, depth)
    const next: Creators = { orcaSessionIds: [], paneKeys: [] }
    this.place(link, depth, chatId, next)
    if (next.orcaSessionIds.length > 0 || next.paneKeys.length > 0) {
      this.walkFrom(db, next, depth + 1)
      return 'changed'
    }
    const placed = this.found.get(link.id)?.dispatch
    return known && JSON.stringify(known.dispatch) === JSON.stringify(placed) ? 'same' : 'changed'
  }

  dispatches(): BotChatTreeDispatch[] {
    return [...this.found.values()].map((entry) => entry.dispatch)
  }

  /** Every session and pane whose Dispatches are the bot's: its chats' and its workers'. */
  creatorKeys(): { sessions: string[]; panes: string[] } {
    return {
      sessions: [...this.creatorSessions, ...this.workerSessions.keys()],
      panes: [...this.creatorPanes, ...this.workerPanes.keys()]
    }
  }

  /** The worktrees the bot's workers ran in. */
  worktreeIds(): string[] {
    return [...this.found.values()].flatMap((entry) =>
      entry.dispatch.worktreeId ? [entry.dispatch.worktreeId] : []
    )
  }
}

function dispatchOf(link: DispatchCreatorLink, chatId: string | null): BotChatTreeDispatch {
  const settled =
    link.status === 'completed' || link.status === 'failed' || link.status === 'circuit_broken'
  return {
    id: link.id,
    chatId,
    settled,
    // A stop or an abandon is the user's call, not a failure.
    failed:
      (link.status === 'failed' &&
        link.lastFailure !== 'stopped' &&
        link.lastFailure !== 'abandoned') ||
      link.status === 'circuit_broken',
    at: link.at,
    ...(settled && !link.completedAtKnown ? { undated: true as const } : {}),
    worktreeId: link.worktreeId,
    ...(link.title ? { title: link.title } : {}),
    ...(link.serverEnvironmentId ? { serverEnvironmentId: link.serverEnvironmentId } : {}),
    ...(link.serverAgent ? { agent: link.serverAgent } : {})
  }
}

/** Every Dispatch the bot's chats started, and the ones their workers started in turn, each with its chat. */
export function botDispatches(
  db: OrchestrationDb,
  chatOfSession: (sessionId: string) => string | null,
  chatOfPaneKey: (paneKey: string) => string | null,
  creators: Creators
): BotChatTreeDispatch[] {
  return new BotDispatchPlacement(chatOfSession, chatOfPaneKey, creators).walk(db).dispatches()
}
