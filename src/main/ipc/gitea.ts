import { ipcMain } from 'electron'
import type {
  GiteaConnectArgs,
  GiteaIssueUpdate,
  GiteaServerSelection,
  GiteaWorkItemFilter
} from '../../shared/types'
import { connect, disconnect, getStatus, selectServer, testConnection } from '../gitea/connect'
import {
  addGiteaIssueComment,
  createGiteaIssue,
  getGiteaIssue,
  listGiteaAssignees,
  listGiteaIssueComments,
  listGiteaLabels,
  listGiteaWorkItems,
  updateGiteaIssue
} from '../gitea/issues'
import type { Store } from '../persistence'
import { _resetPreflightCache } from './preflight'
import { registerGiteaPullRequestHandlers } from './gitea-pr'
import {
  assertRegisteredRepo,
  repoConnectionId,
  type GiteaRepoSelectorArgs
} from './gitea-repo-access'

const VALID_FILTERS = new Set<GiteaWorkItemFilter>(['assigned', 'created', 'all', 'closed'])

function normalizeServerId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeServerSelection(value: unknown): GiteaServerSelection | undefined {
  return normalizeServerId(value) as GiteaServerSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'number') ? value : undefined
}

function normalizeIssueUpdate(value: unknown): GiteaIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as GiteaIssueUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.body !== undefined && typeof input.body !== 'string') {
    return null
  }
  if (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') {
    return null
  }
  if (input.assignees !== undefined && normalizeStringArray(input.assignees) === undefined) {
    return null
  }
  if (input.labelIds !== undefined && normalizeNumberArray(input.labelIds) === undefined) {
    return null
  }
  return input
}

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:connect', async (_event, args: GiteaConnectArgs) => {
    if (typeof args?.baseUrl !== 'string' || typeof args?.token !== 'string') {
      return { ok: false, error: 'Server URL and access token are required.' }
    }
    const result = await connect({ baseUrl: args.baseUrl, token: args.token })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('gitea:disconnect', async (_event, args?: { serverId?: string }) => {
    disconnect(normalizeServerId(args?.serverId))
    _resetPreflightCache()
  })

  ipcMain.handle('gitea:selectServer', async (_event, args: { serverId: GiteaServerSelection }) => {
    const serverId = normalizeServerSelection(args?.serverId)
    if (!serverId) {
      return getStatus()
    }
    return selectServer(serverId)
  })

  ipcMain.handle('gitea:status', async () => getStatus())

  ipcMain.handle('gitea:testConnection', async (_event, args?: { serverId?: string }) => {
    return testConnection(normalizeServerId(args?.serverId))
  })

  ipcMain.handle(
    'gitea:listWorkItems',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { filter?: GiteaWorkItemFilter; limit?: number }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const filter = VALID_FILTERS.has(args?.filter as GiteaWorkItemFilter)
        ? (args.filter as GiteaWorkItemFilter)
        : undefined
      return listGiteaWorkItems(repo.path, filter, clampLimit(args.limit), repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:issue',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return null
      }
      return getGiteaIssue(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:issueComments',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return []
      }
      return listGiteaIssueComments(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle('gitea:labels', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listGiteaLabels(repo.path, repoConnectionId(repo))
  })

  ipcMain.handle('gitea:assignees', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listGiteaAssignees(repo.path, repoConnectionId(repo))
  })

  ipcMain.handle(
    'gitea:createIssue',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        title: string
        body?: string
        assignees?: string[]
        labelIds?: number[]
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.title !== 'string' || !args.title.trim()) {
        return { ok: false, error: 'Title is required.' }
      }
      return createGiteaIssue(
        repo.path,
        {
          title: args.title.trim(),
          body: typeof args.body === 'string' ? args.body : undefined,
          assignees: normalizeStringArray(args.assignees),
          labelIds: normalizeNumberArray(args.labelIds)
        },
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:updateIssue',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; updates: GiteaIssueUpdate }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return { ok: false, error: 'Issue number is required.' }
      }
      const updates = normalizeIssueUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateGiteaIssue(repo.path, args.number, updates, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:addIssueComment',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return { ok: false, error: 'Issue number is required.' }
      }
      if (typeof args.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addGiteaIssueComment(repo.path, args.number, args.body.trim(), repoConnectionId(repo))
    }
  )

  registerGiteaPullRequestHandlers(store)
}
