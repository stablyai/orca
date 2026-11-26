// What a workspace teammate (a share caller whose Orca works in the agent's workspaces) is listed: the
// one place that scopes every list and stream to `agentWorkspaceSet`, the agent's home and its workers'
// worktrees. It narrows what the host lists, never what it lets them do there; the owner gets null.
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  folderWorkspaceKey,
  type WorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import {
  agentHasWorkspace,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { RpcContext } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { botShareOwnsSession } from './bot-share-chats'
import { teammateClientEvent } from './teammate-client-events'

type ViewRuntime = Pick<OrcaRuntimeService, 'readAgentWorkspaceSet' | 'onClientEvent' | 'bots'> &
  Parameters<typeof botShareOwnsSession>[0]

const NO_WORKSPACES: AgentWorkspaceSet = {
  homeKey: 'folder:',
  keys: new Set(),
  repoIds: new Set(),
  groupIds: new Set()
}

/** The workspace teammate's scope, or null for anyone else. */
export function workspaceTeammateOf(
  context: Pick<RpcContext, 'callerScope'>
): BotShareCallerScope | null {
  const scope = context.callerScope
  return scope?.kind === 'bot-share' && scope.workspaces === true ? scope : null
}

export async function readTeammateWorkspaceSet(
  runtime: Pick<OrcaRuntimeService, 'readAgentWorkspaceSet'>,
  scope: BotShareCallerScope
): Promise<AgentWorkspaceSet> {
  return (await runtime.readAgentWorkspaceSet(scope.botId)) ?? NO_WORKSPACES
}

/** One request's lists, each kept to the agent's workspaces; null for anyone but a workspace teammate. */
export async function teammateWorkspaceLists(
  context: Pick<RpcContext, 'callerScope' | 'runtime'>
): Promise<TeammateWorkspaceLists | null> {
  const scope = workspaceTeammateOf(context)
  if (!scope) {
    return null
  }
  const set = await readTeammateWorkspaceSet(context.runtime, scope)
  return teammateWorkspaceListsOf(context.runtime, scope, set)
}

export type TeammateWorkspaceLists = ReturnType<typeof teammateWorkspaceListsOf>

function teammateWorkspaceListsOf(
  runtime: ViewRuntime,
  scope: BotShareCallerScope,
  set: AgentWorkspaceSet
) {
  const has = (id: string | null | undefined) => agentHasWorkspace(set, id)
  return {
    set,
    has,
    /** A `worktree.ps` page: its rows by workspace id, and its count. */
    psRows: <P extends { worktrees: readonly { worktreeId: string }[]; totalCount: number }>(
      page: P
    ): P => {
      const worktrees = page.worktrees.filter((row) => has(row.worktreeId))
      return { ...page, worktrees, totalCount: worktrees.length }
    },
    sessionTabs: teammateSessionTabs(runtime, scope, set.homeKey)
  }
}

/** In the agent's home a teammate sees only their own chats' tabs (each person their own); in its
 *  workers' workspaces, every tab. */
export function teammateSessionTabs(
  runtime: Parameters<typeof botShareOwnsSession>[0],
  scope: BotShareCallerScope,
  homeKey: WorkspaceKey
): (snapshot: RuntimeMobileSessionTabsResult) => RuntimeMobileSessionTabsResult {
  return (snapshot) => {
    if (snapshot.worktree !== homeKey) {
      return snapshot
    }
    const tabs = snapshot.tabs.filter(
      (tab) => tab.type === 'agent-session' && botShareOwnsSession(runtime, scope, tab.sessionId)
    )
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    const kept = new Set(tabs.map((tab) => tab.id))
    const active = snapshot.activeTabId !== null && kept.has(snapshot.activeTabId)
    return {
      ...snapshot,
      tabs,
      activeTabId: active ? snapshot.activeTabId : null,
      activeTabType: active ? snapshot.activeTabType : null,
      ...(snapshot.tabGroups
        ? {
            tabGroups: snapshot.tabGroups.map((group) => ({
              ...group,
              activeTabId:
                group.activeTabId !== null && kept.has(group.activeTabId)
                  ? group.activeTabId
                  : null,
              tabOrder: group.tabOrder.filter((id) => kept.has(id)),
              ...(group.recentTabIds
                ? { recentTabIds: group.recentTabIds.filter((id) => kept.has(id)) }
                : {})
            }))
          }
        : {})
    }
  }
}

/** The home's per-person tab filter for one request, sync: the home is the bot's own folder. */
export function teammateSessionTabsOf(
  context: Pick<RpcContext, 'callerScope' | 'runtime'>
): ((snapshot: RuntimeMobileSessionTabsResult) => RuntimeMobileSessionTabsResult) | null {
  const scope = workspaceTeammateOf(context)
  if (!scope) {
    return null
  }
  const bot = context.runtime.bots.list().find((entry) => entry.id === scope.botId)
  return teammateSessionTabs(
    context.runtime,
    scope,
    bot ? folderWorkspaceKey(bot.folderWorkspaceId) : NO_WORKSPACES.homeKey
  )
}

/** A tab stream's scope for a workspace teammate, once the set is read: the worktrees it hides, the
 *  home's own tabs, and its census kept to the agent's. Null for anyone else. */
export async function openTeammateTabStream(
  context: Pick<RpcContext, 'callerScope' | 'runtime' | 'signal'>
) {
  const scope = workspaceTeammateOf(context)
  if (!scope) {
    return null
  }
  // Built before the stream listens, so a new worker workspace is in the set before its tabs arrive.
  const tracker = new AgentWorkspaceTracker(context.runtime, scope)
  await tracker.ready()
  if (context.signal?.aborted) {
    tracker.dispose()
    throw new Error('client_disconnected')
  }
  return {
    hides: (worktree: string) => !tracker.has(worktree),
    person: teammateSessionTabs(context.runtime, scope, tracker.current().homeKey),
    census: <I extends { snapshots: readonly { worktree: string }[] }>(inventory: I): I => ({
      ...inventory,
      snapshots: inventory.snapshots.filter((snapshot) => tracker.has(snapshot.worktree))
    }),
    dispose: () => tracker.dispose()
  }
}

// Events after which the set may have grown or shrunk: a worktree, repo, Dispatch or bot changed.
function movesTheSet(event: RuntimeClientEvent): boolean {
  return (
    event.type === 'worktreesChanged' ||
    event.type === 'reposChanged' ||
    event.type === 'agentOrchestrationChanged' ||
    (event.type === 'botsChanged' &&
      (event.kinds === undefined || event.kinds.includes('workers') || event.kinds.includes('bot')))
  )
}

/** A stream's live copy of the set: read once, then again after each event that may move it. A
 *  stream's events wait for a pending read, so one that added a workspace is judged after it. */
export class AgentWorkspaceTracker {
  private set: AgentWorkspaceSet = NO_WORKSPACES
  private reading: Promise<void>
  private readonly stopListening: () => void

  constructor(
    private readonly runtime: ViewRuntime,
    readonly scope: BotShareCallerScope
  ) {
    this.reading = this.read()
    // Registered before any stream's own listener, so a stream sees this event's read already pending.
    this.stopListening = runtime.onClientEvent((event) => {
      if (movesTheSet(event)) {
        this.reading = this.reading.then(() => this.read())
      }
    })
  }

  ready(): Promise<void> {
    return this.reading
  }

  has(id: string | null | undefined): boolean {
    return agentHasWorkspace(this.set, id)
  }

  current(): AgentWorkspaceSet {
    return this.set
  }

  /** Each event judged in arrival order against the set as of that event; call once `ready()`. */
  orderedClientEvents(
    emit: (event: RuntimeClientEvent) => void
  ): (event: RuntimeClientEvent) => void {
    let queue: Promise<void> = this.reading
    let pending = 0
    const judge = (event: RuntimeClientEvent) => {
      const kept = teammateClientEvent(event, this.set, this.scope)
      if (kept) {
        emit(kept)
      }
    }
    return (event) => {
      if (pending === 0 && !movesTheSet(event)) {
        judge(event)
        return
      }
      pending += 1
      queue = queue
        .then(() => this.reading)
        .then(() => judge(event))
        // A closed stream's emit may throw; the events after it still run in order.
        .catch(() => undefined)
        .finally(() => {
          pending -= 1
        })
    }
  }

  private async read(): Promise<void> {
    this.set = await readTeammateWorkspaceSet(this.runtime, this.scope).catch(() => this.set)
  }

  dispose(): void {
    this.stopListening()
  }
}
