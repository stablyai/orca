/* eslint-disable max-lines -- Why: Linear IPC validates one namespace in one
   registration boundary so local and SSH runtime schemas can stay mirrored. */
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
import {
  createProject,
  getCustomView,
  getProject,
  listCustomViewIssues,
  listCustomViewProjects,
  listCustomViews,
  listProjectIssues,
  listProjects
} from '../linear/projects'
import { listTeams, getTeamStates, getTeamLabels, getTeamMembers } from '../linear/teams'
import type { LinearListFilter } from '../linear/issues'
import { clampLinearIssueListLimit } from '../../shared/linear-issue-read-limits'
import { optionalParsedLinearIssueAttributeFilter } from '../../shared/linear-issue-attribute-filter'
import type {
  LinearCustomViewModel,
  LinearIssueUpdate,
  LinearWorkspaceSelection
} from '../../shared/types'

const VALID_FILTERS = new Set<LinearListFilter>(['assigned', 'created', 'all', 'completed'])

function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceSelection(value: unknown): LinearWorkspaceSelection | undefined {
  const workspaceId = normalizeWorkspaceId(value)
  return workspaceId as LinearWorkspaceSelection | undefined
}

function normalizeConcreteWorkspaceId(value: unknown): string {
  const workspaceId = normalizeWorkspaceId(value)
  if (!workspaceId || workspaceId === 'all') {
    throw new Error('Concrete Linear workspace ID is required')
  }
  return workspaceId
}

function normalizeCustomViewModel(value: unknown): LinearCustomViewModel {
  if (value !== 'issue' && value !== 'project') {
    throw new Error('Custom view model is required')
  }
  return value
}

function normalizeIdList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    !value.every((id): id is string => typeof id === 'string' && Boolean(id.trim()))
  ) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.map((id) => id.trim())
}

function normalizeOptionalDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.trim()
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
      args?: {
        filter?: LinearListFilter
        limit?: number
        workspaceId?: LinearWorkspaceSelection
        attributeFilter?: unknown
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as LinearListFilter)
        ? (args!.filter as LinearListFilter)
        : undefined
      const limit = clampLinearIssueListLimit(args?.limit)
      // Why: reject malformed filters at the trust boundary instead of
      // normalizing them to empty (which would silently broaden results).
      const attributeFilter =
        args && 'attributeFilter' in args && args.attributeFilter !== undefined
          ? optionalParsedLinearIssueAttributeFilter(args.attributeFilter)
          : undefined
      return listIssues(filter, limit, normalizeWorkspaceSelection(args?.workspaceId), {
        attributeFilter
      })
    }
  )

  ipcMain.handle(
    'linear:createIssue',
    async (
      _event,
      args: {
        teamId: string
        title: string
        description?: string
        workspaceId?: string
        parentIssueId?: string
        projectId?: string | null
        stateId?: string
        priority?: number
        assigneeId?: string | null
        labelIds?: string[]
      }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return { ok: false, error: 'Team ID is required' }
      }
      if (typeof args?.title !== 'string' || !args.title.trim()) {
        return { ok: false, error: 'Title is required' }
      }
      if (
        args.priority !== undefined &&
        (!Number.isInteger(args.priority) || args.priority < 0 || args.priority > 4)
      ) {
        return { ok: false, error: 'Invalid priority' }
      }
      if (
        args.labelIds !== undefined &&
        (!Array.isArray(args.labelIds) ||
          !args.labelIds.every((id) => typeof id === 'string' && id.trim()))
      ) {
        return { ok: false, error: 'Invalid label IDs' }
      }
      return createIssue(
        args.teamId.trim(),
        args.title.trim(),
        args.description?.trim() || undefined,
        normalizeWorkspaceId(args.workspaceId),
        {
          parentId: typeof args.parentIssueId === 'string' ? args.parentIssueId.trim() : undefined,
          projectId: typeof args.projectId === 'string' ? args.projectId.trim() : null,
          stateId: typeof args.stateId === 'string' ? args.stateId.trim() : undefined,
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId.trim() : null,
          labelIds: Array.isArray(args.labelIds) ? args.labelIds.map((id) => id.trim()) : undefined
        }
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
      if (u.title !== undefined && (typeof u.title !== 'string' || !u.title.trim())) {
        return { ok: false, error: 'Title is required' }
      }
      if (u.description !== undefined && typeof u.description !== 'string') {
        return { ok: false, error: 'Description must be a string' }
      }
      if (
        u.priority !== undefined &&
        (!Number.isInteger(u.priority) || u.priority < 0 || u.priority > 4)
      ) {
        return { ok: false, error: 'Priority must be an integer 0-4' }
      }
      if (
        u.estimate !== undefined &&
        u.estimate !== null &&
        (!Number.isInteger(u.estimate) || u.estimate < 0)
      ) {
        return { ok: false, error: 'Estimate must be a non-negative integer' }
      }
      if (
        u.labelIds !== undefined &&
        (!Array.isArray(u.labelIds) || !u.labelIds.every((id: unknown) => typeof id === 'string'))
      ) {
        return { ok: false, error: 'Label IDs must be an array of strings' }
      }
      if (
        u.projectId !== undefined &&
        u.projectId !== null &&
        (typeof u.projectId !== 'string' || !u.projectId.trim())
      ) {
        return { ok: false, error: 'Invalid project ID' }
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
    'linear:listProjects',
    async (
      _event,
      args?: {
        query?: string
        limit?: number
        workspaceId?: LinearWorkspaceSelection
        force?: boolean
      }
    ) => {
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listProjects(
        args?.query,
        limit,
        normalizeWorkspaceSelection(args?.workspaceId),
        args?.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:createProject',
    async (
      _event,
      args: {
        name: string
        description?: string
        content?: string
        teamIds?: string[]
        leadId?: string | null
        memberIds?: string[]
        labelIds?: string[]
        priority?: number
        startDate?: string
        targetDate?: string
        workspaceId?: string
      }
    ) => {
      if (typeof args?.name !== 'string' || !args.name.trim()) {
        return { ok: false, error: 'Project name is required' }
      }
      let teamIds: string[]
      try {
        teamIds = normalizeIdList(args.teamIds, 'team IDs') ?? []
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Invalid team IDs' }
      }
      if (teamIds.length === 0) {
        return { ok: false, error: 'At least one team is required' }
      }
      if (
        args.priority !== undefined &&
        (!Number.isInteger(args.priority) || args.priority < 0 || args.priority > 4)
      ) {
        return { ok: false, error: 'Invalid priority' }
      }
      let memberIds: string[] | undefined
      let labelIds: string[] | undefined
      let startDate: string | undefined
      let targetDate: string | undefined
      try {
        memberIds = normalizeIdList(args.memberIds, 'member IDs')
        labelIds = normalizeIdList(args.labelIds, 'label IDs')
        startDate = normalizeOptionalDate(args.startDate, 'start date')
        targetDate = normalizeOptionalDate(args.targetDate, 'target date')
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Invalid project' }
      }
      return createProject(
        {
          name: args.name.trim(),
          description: args.description?.trim() || undefined,
          content: args.content?.trim() || undefined,
          teamIds,
          leadId: normalizeWorkspaceId(args.leadId),
          memberIds,
          labelIds,
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          startDate,
          targetDate
        },
        normalizeWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:getProject',
    async (_event, args: { id: string; workspaceId?: string; force?: boolean }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('Project ID is required')
      }
      return getProject(
        args.id.trim(),
        normalizeConcreteWorkspaceId(args.workspaceId),
        args.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:listProjectIssues',
    async (
      _event,
      args: { projectId: string; limit?: number; workspaceId?: string; force?: boolean }
    ) => {
      if (typeof args?.projectId !== 'string' || !args.projectId.trim()) {
        throw new Error('Project ID is required')
      }
      const limit = clampLinearIssueListLimit(args?.limit)
      return listProjectIssues(
        args.projectId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId),
        args.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:listCustomViews',
    async (
      _event,
      args?: {
        model?: LinearCustomViewModel
        limit?: number
        workspaceId?: LinearWorkspaceSelection
        force?: boolean
      }
    ) => {
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listCustomViews(
        normalizeCustomViewModel(args?.model),
        limit,
        normalizeWorkspaceSelection(args?.workspaceId),
        args?.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:getCustomView',
    async (
      _event,
      args: {
        viewId: string
        model?: LinearCustomViewModel
        workspaceId?: string
        force?: boolean
      }
    ) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      return getCustomView(
        args.viewId.trim(),
        normalizeCustomViewModel(args.model),
        normalizeConcreteWorkspaceId(args.workspaceId),
        args.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:listCustomViewIssues',
    async (
      _event,
      args: { viewId: string; limit?: number; workspaceId?: string; force?: boolean }
    ) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      const limit = clampLinearIssueListLimit(args?.limit)
      return listCustomViewIssues(
        args.viewId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId),
        args.force === true
      )
    }
  )

  ipcMain.handle(
    'linear:listCustomViewProjects',
    async (
      _event,
      args: { viewId: string; limit?: number; workspaceId?: string; force?: boolean }
    ) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listCustomViewProjects(
        args.viewId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId),
        args.force === true
      )
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
