// What a workspace teammate (a share caller whose Orca works in the agent's workspaces) is listed: the
// one place that scopes every list and stream to `agentWorkspaceSet`, the agent's home and its workers'
// worktrees. It narrows what the host lists, never what it lets them do there; the owner gets null.
import {
  agentHasWorkspace,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { RpcContext } from '../../runtime/rpc/core'
import { chatWorkspaceOf } from './teammate-client-events'
import {
  openTracker,
  readTeammateWorkspaceSet,
  workspaceTeammateOf
} from './agent-workspace-tracker'

// `getWorktreePs`'s own default page.
const DEFAULT_PS_LIMIT = 200

/** A chats-only teammate's file reads stay in the agent's home folder; the workspace tier reads every
 *  workspace as the owner does, so it is never held to that folder. */
export function folderConfinedTeammateOf(
  context: Pick<RpcContext, 'callerScope'>
): BotShareCallerScope | null {
  const scope = context.callerScope
  return scope?.kind === 'bot-share' && scope.workspaceTier !== true ? scope : null
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
  return teammateWorkspaceListsOf(set)
}

export type TeammateWorkspaceLists = ReturnType<typeof teammateWorkspaceListsOf>

function teammateWorkspaceListsOf(set: AgentWorkspaceSet) {
  const has = (id: string | null | undefined) => agentHasWorkspace(set, id)
  return {
    set,
    has,
    /** A `worktree.ps` page read unlimited: the agent's rows, their count, then the first `limit`
     *  (the listing's own default when absent). */
    psRows: <
      P extends {
        worktrees: readonly { worktreeId: string }[]
        totalCount: number
        truncated: boolean
      }
    >(
      page: P,
      limit = DEFAULT_PS_LIMIT
    ): P => {
      const worktrees = page.worktrees.filter((row) => has(row.worktreeId))
      return {
        ...page,
        worktrees: worktrees.slice(0, limit),
        totalCount: worktrees.length,
        truncated: worktrees.length > limit
      }
    }
  }
}

/** A tab stream's scope for a workspace teammate, once the set is read: the home's own tabs, its
 *  census kept to the agent's, and its tab changes registered to run in order after any re-read
 *  they wait on, for the agent's worktrees and those `shown` already holds (so a removal arrives).
 *  Null for anyone else. */
export async function openTeammateTabStream(
  context: Pick<RpcContext, 'callerScope' | 'runtime' | 'signal'>,
  shown: ReadonlyMap<string, unknown>
) {
  const tracker = await openTracker(context)
  if (!tracker) {
    return null
  }
  const onTabsChanged = context.runtime.onMobileSessionTabsChanged.bind(context.runtime)
  return {
    census: <I extends { snapshots: readonly { worktree: string }[] }>(inventory: I): I => ({
      ...inventory,
      snapshots: inventory.snapshots.filter((snapshot) => tracker.has(snapshot.worktree))
    }),
    onMobileSessionTabsChanged: ((listener, ...rest) =>
      onTabsChanged(
        (snapshot, ...args) =>
          tracker.after(() => {
            if (tracker.has(snapshot.worktree) || shown.has(snapshot.worktree)) {
              listener(snapshot, ...args)
            }
          }),
        ...rest
      )) satisfies typeof onTabsChanged,
    dispose: () => tracker.dispose()
  }
}

/** A chat status stream's filter for a workspace teammate: chats in the agent's workspaces. */
export async function openTeammateChatFilter(
  context: Pick<RpcContext, 'callerScope' | 'runtime' | 'signal'>
) {
  const tracker = await openTracker(context)
  return tracker
    ? {
        listed: (sessionId: string) => tracker.has(chatWorkspaceOf(sessionId)),
        dispose: () => tracker.dispose()
      }
    : null
}
