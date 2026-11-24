import { ipcMain } from 'electron'
import type { z } from 'zod'
import {
  connect,
  disconnect,
  getStatus,
  testConnection
} from '../../gitea/servers/gitea-server-connection'
import {
  addGiteaIssueComment,
  createGiteaIssue,
  getGiteaIssue,
  listGiteaAssignees,
  listGiteaIssueComments,
  listGiteaLabels,
  listGiteaWorkItems,
  updateGiteaIssue
} from '../../gitea/issues/gitea-issues'
import {
  GiteaAddIssueComment,
  GiteaConnectParams,
  GiteaCreateIssue,
  GiteaIssueByNumber,
  GiteaServerIdParams,
  GiteaUpdateIssue,
  GiteaWorkItemsList
} from '../../../shared/rpc-contract/source-control/gitea-params'
import type { Store } from '../../persistence/loading-store/store'
import { _resetPreflightCache } from '../../preflight/agent-detection'
import { registerGiteaPullRequestHandlers } from './gitea-pull-request-handlers'
import { giteaRepoTarget, type GiteaRepoSelectorArgs } from './gitea-repo-access'

type RepoScoped<Schema extends z.ZodObject> = GiteaRepoSelectorArgs & Omit<z.input<Schema>, 'repo'>

/** Validates a repo-scoped payload with the shared RPC schema; the repo comes from the selector. */
export function parseGiteaRepoArgs<Schema extends z.ZodObject>(
  schema: Schema,
  args: GiteaRepoSelectorArgs,
  store: Store
): { target: ReturnType<typeof giteaRepoTarget>; params: z.output<Schema> } {
  const target = giteaRepoTarget(args, store)
  return { target, params: schema.parse({ ...args, repo: target.repoPath }) }
}

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:connect', async (_event, args: unknown) => {
    const result = await connect(GiteaConnectParams.parse(args))
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('gitea:disconnect', async (_event, args: unknown) => {
    await disconnect(GiteaServerIdParams.parse(args).serverId)
    _resetPreflightCache()
  })

  ipcMain.handle('gitea:status', async () => getStatus())

  ipcMain.handle('gitea:testConnection', async (_event, args: unknown) =>
    testConnection(GiteaServerIdParams.parse(args).serverId)
  )

  ipcMain.handle(
    'gitea:listWorkItems',
    async (_event, args: RepoScoped<typeof GiteaWorkItemsList>) => {
      const { target, params } = parseGiteaRepoArgs(GiteaWorkItemsList, args, store)
      return listGiteaWorkItems(target, params.filter, params.limit)
    }
  )

  ipcMain.handle('gitea:issue', async (_event, args: RepoScoped<typeof GiteaIssueByNumber>) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return getGiteaIssue(target, params.number)
  })

  ipcMain.handle(
    'gitea:issueComments',
    async (_event, args: RepoScoped<typeof GiteaIssueByNumber>) => {
      const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
      return listGiteaIssueComments(target, params.number)
    }
  )

  ipcMain.handle('gitea:labels', async (_event, args: GiteaRepoSelectorArgs) =>
    listGiteaLabels(giteaRepoTarget(args, store))
  )

  ipcMain.handle('gitea:assignees', async (_event, args: GiteaRepoSelectorArgs) =>
    listGiteaAssignees(giteaRepoTarget(args, store))
  )

  ipcMain.handle('gitea:createIssue', async (_event, args: RepoScoped<typeof GiteaCreateIssue>) => {
    const { target, params } = parseGiteaRepoArgs(GiteaCreateIssue, args, store)
    return createGiteaIssue(target, {
      title: params.title,
      body: params.body,
      assignees: params.assignees,
      labelIds: params.labelIds
    })
  })

  ipcMain.handle('gitea:updateIssue', async (_event, args: RepoScoped<typeof GiteaUpdateIssue>) => {
    const { target, params } = parseGiteaRepoArgs(GiteaUpdateIssue, args, store)
    return updateGiteaIssue(target, params.number, params.updates)
  })

  ipcMain.handle(
    'gitea:addIssueComment',
    async (_event, args: RepoScoped<typeof GiteaAddIssueComment>) => {
      const { target, params } = parseGiteaRepoArgs(GiteaAddIssueComment, args, store)
      return addGiteaIssueComment(target, params.number, params.body)
    }
  )

  registerGiteaPullRequestHandlers(store)
}
