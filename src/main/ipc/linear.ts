import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../linear/client'
import { _resetPreflightCache } from './preflight'
import {
  getIssue,
  searchIssues,
  listIssues,
  createIssue,
  updateIssue,
  addIssueComment,
  getIssueComments
} from '../linear/issues'
import { listTeams, getTeamStates, getTeamLabels, getTeamMembers } from '../linear/teams'
import type { LinearListFilter } from '../linear/issues'
import type { LinearIssueUpdate, LinearWorkspaceSelection } from '../../shared/types'

const VALID_FILTERS = new Set<LinearListFilter>(['assigned', 'created', 'all', 'completed'])

function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceSelection(value: unknown): LinearWorkspaceSelection | undefined {
  const workspaceId = normalizeWorkspaceId(value)
  return workspaceId as LinearWorkspaceSelection | undefined
}

export function registerLinearHandlers(): void {
  ipcMain.handle('linear:connect', async (_event, args: { apiKey: string }) => {
    if (typeof args?.apiKey !== 'string' || !args.apiKey.trim()) {
      return { ok: false, error: 'Invalid API key' }
    }
    const result = await connect(args.apiKey.trim())
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('linear:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  ipcMain.handle('linear:selectWorkspace', async (_event, args: { workspaceId: string }) => {
    const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
    if (!workspaceId) {
      return getStatus()
    }
    return selectWorkspace(workspaceId)
  })

  ipcMain.handle('linear:status', async () => {
    return getStatus()
  })

  ipcMain.handle('linear:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  ipcMain.handle(
    'linear:searchIssues',
    async (
      _event,
      args: { query: string; limit?: number; workspaceId?: LinearWorkspaceSelection }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      const limit = Math.min(Math.max(1, args.limit ?? 20), 50)
      return searchIssues(args.query, limit, normalizeWorkspaceSelection(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:listIssues',
    async (
      _event,
      args?: { filter?: LinearListFilter; limit?: number; workspaceId?: LinearWorkspaceSelection }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as LinearListFilter)
        ? (args!.filter as LinearListFilter)
        : undefined
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listIssues(filter, limit, normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:createIssue',
    async (
      _event,
      args: { teamId: string; title: string; description?: string; workspaceId?: string }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return { ok: false, error: 'Team ID is required' }
      }
      if (typeof args?.title !== 'string' || !args.title.trim()) {
        return { ok: false, error: 'Title is required' }
      }
      return createIssue(
        args.teamId.trim(),
        args.title.trim(),
        args.description?.trim() || undefined,
        normalizeWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle('linear:getIssue', async (_event, args: { id: string; workspaceId?: string }) => {
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return null
    }
    return getIssue(args.id.trim(), normalizeWorkspaceId(args.workspaceId))
  })

  ipcMain.handle(
    'linear:updateIssue',
    async (_event, args: { id: string; updates: LinearIssueUpdate; workspaceId?: string }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      // Why: IPC args are untyped at runtime — validate the updates object and
      // individual fields to prevent the Linear SDK from receiving unexpected
      // primitives that would produce confusing API errors.
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      const u = args.updates
      if (u.stateId !== undefined && (typeof u.stateId !== 'string' || !u.stateId.trim())) {
        return { ok: false, error: 'Invalid state ID' }
      }
      if (
        u.priority !== undefined &&
        (!Number.isInteger(u.priority) || u.priority < 0 || u.priority > 4)
      ) {
        return { ok: false, error: 'Priority must be an integer 0-4' }
      }
      if (
        u.labelIds !== undefined &&
        (!Array.isArray(u.labelIds) || !u.labelIds.every((id: unknown) => typeof id === 'string'))
      ) {
        return { ok: false, error: 'Label IDs must be an array of strings' }
      }
      return updateIssue(args.id.trim(), args.updates, normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:addIssueComment',
    async (_event, args: { issueId: string; body: string; workspaceId?: string }) => {
      if (typeof args?.issueId !== 'string' || !args.issueId.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body is required' }
      }
      return addIssueComment(
        args.issueId.trim(),
        args.body.trim(),
        normalizeWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:issueComments',
    async (_event, args: { issueId: string; workspaceId?: string }) => {
      if (typeof args?.issueId !== 'string' || !args.issueId.trim()) {
        return []
      }
      return getIssueComments(args.issueId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:listTeams',
    async (_event, args?: { workspaceId?: LinearWorkspaceSelection }) => {
      return listTeams(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamStates',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamStates(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamLabels',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamLabels(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:teamMembers',
    async (_event, args: { teamId: string; workspaceId?: string }) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamMembers(args.teamId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )
}
