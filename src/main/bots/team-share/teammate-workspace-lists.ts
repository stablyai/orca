// The lists a workspace teammate reads, each kept to the agent's workspaces: one table, applied to the
// admitted method once (`withTeammateLists`), so no handler scopes its own answer. Streams that must
// filter before they encode deltas (client events, tab streams, `worktree.ps`) do it in their handlers,
// through `teammate-workspace-view.ts`.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import { isStreamingMethod } from '../../runtime/rpc/core'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { locateParty } from '../../runtime/rpc/methods/orchestration/caller-show'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { teammateWorkspaceLists, type TeammateWorkspaceLists } from './teammate-workspace-view'

type Row = Record<string, unknown>
type ListScope = {
  /** Before the handler: a stream outside the agent's workspaces is refused as not found. */
  before?: (params: unknown, context: RpcContext, lists: TeammateWorkspaceLists) => Promise<void>
  /** After the handler: its answer, kept to the agent's workspaces. */
  after?: (result: unknown, lists: TeammateWorkspaceLists) => unknown
}

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `result[field]`'s rows that `keep` accepts, and a `totalCount` that counts them. */
function keepRows(result: unknown, field: string, keep: (row: Row) => boolean): unknown {
  const rows = isRow(result) ? result[field] : undefined
  if (!isRow(result) || !Array.isArray(rows)) {
    return result
  }
  const kept = rows.filter((row) => isRow(row) && keep(row))
  return {
    ...result,
    [field]: kept,
    ...('totalCount' in result ? { totalCount: kept.length } : {})
  }
}

/** Records keyed by a worktree id or workspace key, in each of `fields`. */
function keepKeyed(result: unknown, fields: readonly string[], has: (id: string) => boolean) {
  if (!isRow(result)) {
    return result
  }
  const kept = { ...result }
  for (const field of fields) {
    const records = result[field]
    if (isRow(records)) {
      kept[field] = Object.fromEntries(Object.entries(records).filter(([key]) => has(key)))
    }
  }
  return kept
}

const byWorktreeId = (field: string): ListScope => ({
  after: (result, { has }) => keepRows(result, field, (row) => has(text(row.worktreeId)))
})
const byId = (field: string): ListScope => ({
  after: (result, { has }) => keepRows(result, field, (row) => has(text(row.id)))
})

/** Their repos' and folders' groups, with every group above them so the tree still nests. */
function groupsAbove(result: unknown, groupIds: ReadonlySet<string>): unknown {
  const groups = isRow(result) && Array.isArray(result.groups) ? result.groups.filter(isRow) : []
  const byGroupId = new Map(groups.map((group) => [text(group.id), group]))
  const kept = new Set<string>()
  for (const id of groupIds) {
    for (let group = byGroupId.get(id); group;) {
      const groupId = text(group.id)
      if (!groupId || kept.has(groupId)) {
        break
      }
      kept.add(groupId)
      group = byGroupId.get(text(group.parentGroupId))
    }
  }
  return keepRows(result, 'groups', (group) => kept.has(text(group.id) ?? ''))
}

/** A crew is watched by its party: a chat's or terminal's, which must be one of the agent's. */
async function refuseOtherParty(
  params: unknown,
  context: RpcContext,
  { has }: TeammateWorkspaceLists
): Promise<void> {
  const party = isRow(params) ? text(params.party) : undefined
  const { location } = party ? await locateParty({ address: party }, context) : { location: null }
  const workspace =
    location?.kind === 'chat'
      ? location.worktreeId
      : location?.kind === 'terminal' && !location.environmentId
        ? context.runtime.getTerminalWorktreeIdForHandle(location.handle)
        : null
  if (!has(workspace)) {
    throw new OrchestrationError('not_found', `No party ${party} in this shared agent's workspaces`)
  }
}

const TEAMMATE_LISTS: Readonly<Record<string, ListScope>> = {
  'repo.list': {
    after: (result, { set }) =>
      keepRows(result, 'repos', (row) => set.repoIds.has(text(row.id) ?? ''))
  },
  'worktree.list': byId('worktrees'),
  'worktree.detectedList': byId('worktrees'),
  'worktree.lineageList': {
    after: (result, { has }) =>
      keepKeyed(result, ['lineage', 'workspaceLineage', 'crossStoreLineage'], has)
  },
  'folderWorkspace.list': {
    after: (result, { has }) =>
      keepRows(result, 'folderWorkspaces', (row) => has(`folder:${text(row.id)}`))
  },
  'projectGroup.list': { after: (result, { set }) => groupsAbove(result, set.groupIds) },
  'terminal.list': byWorktreeId('terminals'),
  'browser.tabList': byWorktreeId('tabs'),
  'session.tabs.list': {
    after: (result, { sessionTabs }) => (isTabs(result) ? sessionTabs(result) : result)
  },
  'session.tabs.listAll': {
    after: (result, lists) => {
      const kept = keepRows(result, 'snapshots', (row) => lists.has(text(row.worktree)))
      return isRow(kept) && Array.isArray(kept.snapshots)
        ? { ...kept, snapshots: kept.snapshots.filter(isTabs).map(lists.sessionTabs) }
        : kept
    }
  },
  'orchestration.crewSubscribe': { before: refuseOtherParty },
  'orchestration.workerApprovalsSubscribe': { before: refuseOtherParty }
}

function isTabs(value: unknown): value is RuntimeMobileSessionTabsResult {
  return isRow(value) && typeof value.worktree === 'string' && Array.isArray(value.tabs)
}

/** The admitted method as a workspace teammate runs it: its listed answer kept to the agent's
 *  workspaces. Every method off the table runs as it is. */
export function withTeammateLists<M extends RpcMethod | RpcStreamingMethod>(method: M): M {
  const scope = TEAMMATE_LISTS[method.name]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scoped() replaces only the handler, with one of the same signature.
  return scope ? (scoped(method, scope) as M) : method
}

function scoped(
  method: RpcMethod | RpcStreamingMethod,
  scope: ListScope
): RpcMethod | RpcStreamingMethod {
  if (isStreamingMethod(method)) {
    return {
      ...method,
      handler: async (params, context, emit) => {
        await scope.before?.(params, context, await listsFor(context))
        return method.handler(params, context, emit)
      }
    }
  }
  return {
    ...method,
    handler: async (params, context) => {
      const lists = await listsFor(context)
      await scope.before?.(params, context, lists)
      const result = await method.handler(params, context)
      return scope.after ? scope.after(result, lists) : result
    }
  }
}

async function listsFor(context: RpcContext): Promise<TeammateWorkspaceLists> {
  const lists = await teammateWorkspaceLists(context)
  if (!lists) {
    throw new Error('teammate_scope_missing')
  }
  return lists
}
