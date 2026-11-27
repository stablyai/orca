// The lists a workspace teammate reads, each kept to the agent's workspaces: one table, applied to the
// admitted method once (`withTeammateLists`), so no handler scopes its own answer. Answers that must be
// filtered before they are snapshotted or encoded as deltas (repo.list, client events, tab streams,
// worktree.ps, layout.subscribe, chat status) are filtered in their handlers, through
// `teammate-workspace-view.ts`; `TEAMMATE_HANDLER_FILTERED` names them.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import { isStreamingMethod } from '../../runtime/rpc/core'
import { teammateWorkspaceLists, type TeammateWorkspaceLists } from './teammate-workspace-view'

type Row = Record<string, unknown>
type ListScope = {
  /** The answer, kept to the agent's workspaces. */
  after: (result: unknown, lists: TeammateWorkspaceLists) => unknown
  /** The page's `limit` param, applied after filtering so the owner's rows never use it up. */
  limited?: string
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

const byWorktreeId = (field: string, limited?: string): ListScope => ({
  after: (result, { has }) => keepRows(result, field, (row) => has(text(row.worktreeId))),
  ...(limited ? { limited } : {})
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

const TEAMMATE_LISTS: Readonly<Record<string, ListScope>> = {
  'worktree.list': {
    after: (result, { has }) => keepRows(result, 'worktrees', (row) => has(text(row.id))),
    limited: 'worktrees'
  },
  'worktree.detectedList': {
    after: (result, { has }) => keepRows(result, 'worktrees', (row) => has(text(row.id)))
  },
  'worktree.lineageList': {
    after: (result, { has }) =>
      keepKeyed(result, ['lineage', 'workspaceLineage', 'crossStoreLineage'], has)
  },
  'folderWorkspace.list': {
    after: (result, { has }) =>
      keepRows(result, 'folderWorkspaces', (row) => has(`folder:${text(row.id)}`))
  },
  'projectGroup.list': { after: (result, { set }) => groupsAbove(result, set.groupIds) },
  'terminal.list': byWorktreeId('terminals', 'terminals'),
  'browser.tabList': byWorktreeId('tabs'),
  'agent.list': byWorktreeId('agents'),
  'session.tabs.listAll': {
    after: (result, { has }) => keepRows(result, 'snapshots', (row) => has(text(row.worktree)))
  }
}

/** The filtered methods whose handlers keep their own answers to the agent's workspaces. */
export const TEAMMATE_HANDLER_FILTERED: ReadonlySet<string> = new Set([
  'repo.list',
  'worktree.ps',
  'runtime.clientEvents.subscribe',
  'session.tabs.subscribeAll',
  'layout.subscribe',
  'agentSession.subscribeStatus',
  'status.get',
  // Shared views (`botShareScopedView`): the shared agent's own, as for any teammate.
  'bots.list',
  'bots.roster',
  'bots.chats.own',
  'bots.agentChoices',
  'bots.github.state',
  'bots.linear.state',
  'google.status'
])

export const TEAMMATE_LISTED_METHODS: ReadonlySet<string> = new Set(Object.keys(TEAMMATE_LISTS))

/** The admitted method as a workspace teammate runs it: its listed answer kept to the agent's
 *  workspaces. Every method off the table runs as it is. */
export function withTeammateLists<M extends RpcMethod | RpcStreamingMethod>(method: M): M {
  const scope = TEAMMATE_LISTS[method.name]
  if (!scope || isStreamingMethod(method)) {
    return method
  }
  const handler: RpcMethod['handler'] = async (params, context) => {
    const lists = await listsFor(context)
    const limit = scope.limited && isRow(params) ? params.limit : undefined
    const widened =
      isRow(params) && typeof limit === 'number'
        ? { ...params, limit: Number.MAX_SAFE_INTEGER }
        : params
    const kept = scope.after(await method.handler(widened, context), lists)
    return typeof limit === 'number' && scope.limited ? firstRows(kept, scope.limited, limit) : kept
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only a unary method's handler is replaced, with one of the same signature.
  return { ...method, handler } as M
}

/** The first `limit` of `field`'s rows, marked truncated when more were kept. */
function firstRows(result: unknown, field: string, limit: number): unknown {
  const rows = isRow(result) ? result[field] : undefined
  if (!isRow(result) || !Array.isArray(rows) || rows.length <= limit) {
    return result
  }
  return { ...result, [field]: rows.slice(0, limit), truncated: true }
}

async function listsFor(context: RpcContext): Promise<TeammateWorkspaceLists> {
  const lists = await teammateWorkspaceLists(context)
  if (!lists) {
    throw new Error('teammate_scope_missing')
  }
  return lists
}
