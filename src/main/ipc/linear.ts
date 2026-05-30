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
  getCustomView,
  getProject,
  listCustomViewIssues,
  listCustomViewProjects,
  listCustomViews,
  listProjectIssues,
  listProjects
} from '../linear/projects'
import { listTeams, getTeamStates, getTeamLabels, getTeamMembers } from '../linear/teams'
import {
  createIssueLabel,
  listIssueLabels,
  restoreIssueLabel,
  retireIssueLabel,
  updateIssueLabel
} from '../linear/labels'
import type { LinearListFilter } from '../linear/issues'
import type {
  LinearCustomViewModel,
  LinearIssueLabelCreateInput,
  LinearIssueLabelUpdateInput,
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

function normalizeOptionalStringField(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  options: { nullable?: boolean } = {}
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  const value = raw[key]
  if (value === undefined) {
    return { ok: true, value: undefined }
  }
  if (value === null && options.nullable) {
    return { ok: true, value: null }
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `${label} must be a string${options.nullable ? ' or null' : ''}`
    }
  }
  return { ok: true, value: value.trim() || undefined }
}

function normalizeOptionalWorkspaceId(
  raw: Record<string, unknown>
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const value = raw.workspaceId
  if (value === undefined) {
    return { ok: true, value: undefined }
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'Workspace ID must be a string' }
  }
  return { ok: true, value: value.trim() || undefined }
}

function normalizeOptionalBooleanField(
  raw: Record<string, unknown>,
  key: string,
  label: string
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  const value = raw[key]
  if (value === undefined) {
    return { ok: true, value: undefined }
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: `${label} must be a boolean` }
  }
  return { ok: true, value }
}

function normalizeLabelCreateInput(
  value: unknown
): { ok: true; input: LinearIssueLabelCreateInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Label input is required' }
  }
  const raw = value as Record<string, unknown>
  const name = normalizeWorkspaceId(raw.name)
  if (!name) {
    return { ok: false, error: 'Label name is required' }
  }
  const color = normalizeOptionalStringField(raw, 'color', 'Label color')
  if (!color.ok) {
    return color
  }
  const description = normalizeOptionalStringField(raw, 'description', 'Label description', {
    nullable: true
  })
  if (!description.ok) {
    return description
  }
  const teamId = normalizeOptionalStringField(raw, 'teamId', 'Label team ID', { nullable: true })
  if (!teamId.ok) {
    return teamId
  }
  const parentId = normalizeOptionalStringField(raw, 'parentId', 'Label parent ID', {
    nullable: true
  })
  if (!parentId.ok) {
    return parentId
  }
  const isGroup = normalizeOptionalBooleanField(raw, 'isGroup', 'Label group flag')
  if (!isGroup.ok) {
    return isGroup
  }
  return {
    ok: true,
    input: {
      name,
      color: color.value ?? undefined,
      description: description.value,
      teamId: teamId.value,
      parentId: parentId.value,
      isGroup: isGroup.value
    }
  }
}

function normalizeLabelUpdateInput(
  value: unknown
): { ok: true; input: LinearIssueLabelUpdateInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Label input is required' }
  }
  const raw = value as Record<string, unknown>
  const name = normalizeOptionalStringField(raw, 'name', 'Label name')
  if (!name.ok) {
    return name
  }
  if (raw.name !== undefined && !name.value) {
    return { ok: false, error: 'Label name is required' }
  }
  const color = normalizeOptionalStringField(raw, 'color', 'Label color')
  if (!color.ok) {
    return color
  }
  const description = normalizeOptionalStringField(raw, 'description', 'Label description', {
    nullable: true
  })
  if (!description.ok) {
    return description
  }
  const parentId = normalizeOptionalStringField(raw, 'parentId', 'Label parent ID', {
    nullable: true
  })
  if (!parentId.ok) {
    return parentId
  }
  const isGroup = normalizeOptionalBooleanField(raw, 'isGroup', 'Label group flag')
  if (!isGroup.ok) {
    return isGroup
  }
  return {
    ok: true,
    input: {
      name: name.value ?? undefined,
      color: color.value ?? undefined,
      description: description.value,
      parentId: parentId.value,
      isGroup: isGroup.value
    }
  }
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
      args?: { query?: string; limit?: number; workspaceId?: LinearWorkspaceSelection }
    ) => {
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listProjects(args?.query, limit, normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:getProject',
    async (_event, args: { id: string; workspaceId?: string }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('Project ID is required')
      }
      return getProject(args.id.trim(), normalizeConcreteWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'linear:listProjectIssues',
    async (_event, args: { projectId: string; limit?: number; workspaceId?: string }) => {
      if (typeof args?.projectId !== 'string' || !args.projectId.trim()) {
        throw new Error('Project ID is required')
      }
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listProjectIssues(
        args.projectId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId)
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
      }
    ) => {
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listCustomViews(
        normalizeCustomViewModel(args?.model),
        limit,
        normalizeWorkspaceSelection(args?.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:getCustomView',
    async (
      _event,
      args: { viewId: string; model?: LinearCustomViewModel; workspaceId?: string }
    ) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      return getCustomView(
        args.viewId.trim(),
        normalizeCustomViewModel(args.model),
        normalizeConcreteWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:listCustomViewIssues',
    async (_event, args: { viewId: string; limit?: number; workspaceId?: string }) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listCustomViewIssues(
        args.viewId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:listCustomViewProjects',
    async (_event, args: { viewId: string; limit?: number; workspaceId?: string }) => {
      if (typeof args?.viewId !== 'string' || !args.viewId.trim()) {
        throw new Error('Custom view ID is required')
      }
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listCustomViewProjects(
        args.viewId.trim(),
        limit,
        normalizeConcreteWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'linear:listIssueLabels',
    async (
      _event,
      args?: { workspaceId?: LinearWorkspaceSelection; teamId?: string; includeArchived?: boolean }
    ) => {
      const rawArgs = (args ?? {}) as Record<string, unknown>
      const workspaceId = normalizeOptionalWorkspaceId(rawArgs)
      if (!workspaceId.ok) {
        throw new Error(workspaceId.error)
      }
      const teamId = normalizeOptionalStringField(rawArgs, 'teamId', 'Label team ID')
      if (!teamId.ok) {
        throw new Error(teamId.error)
      }
      if (rawArgs.includeArchived !== undefined && typeof rawArgs.includeArchived !== 'boolean') {
        throw new Error('includeArchived must be a boolean')
      }
      return listIssueLabels({
        workspaceId: workspaceId.value as LinearWorkspaceSelection | undefined,
        teamId: teamId.value ?? undefined,
        includeArchived: args?.includeArchived === true
      })
    }
  )

  ipcMain.handle(
    'linear:createIssueLabel',
    async (_event, args: { input?: unknown; workspaceId?: string }) => {
      const workspaceId = normalizeOptionalWorkspaceId((args ?? {}) as Record<string, unknown>)
      if (!workspaceId.ok) {
        return workspaceId
      }
      const normalized = normalizeLabelCreateInput(args?.input)
      if (!normalized.ok) {
        return normalized
      }
      return createIssueLabel(normalized.input, workspaceId.value)
    }
  )

  ipcMain.handle(
    'linear:updateIssueLabel',
    async (_event, args: { id?: string; input?: unknown; workspaceId?: string }) => {
      const id = normalizeWorkspaceId(args?.id)
      if (!id) {
        return { ok: false, error: 'Label ID is required' }
      }
      const workspaceId = normalizeOptionalWorkspaceId((args ?? {}) as Record<string, unknown>)
      if (!workspaceId.ok) {
        return workspaceId
      }
      const normalized = normalizeLabelUpdateInput(args.input)
      if (!normalized.ok) {
        return normalized
      }
      return updateIssueLabel(id, normalized.input, workspaceId.value)
    }
  )

  ipcMain.handle(
    'linear:retireIssueLabel',
    async (_event, args: { id?: string; workspaceId?: string }) => {
      const id = normalizeWorkspaceId(args?.id)
      if (!id) {
        return { ok: false, error: 'Label ID is required' }
      }
      const workspaceId = normalizeOptionalWorkspaceId((args ?? {}) as Record<string, unknown>)
      if (!workspaceId.ok) {
        return workspaceId
      }
      return retireIssueLabel(id, workspaceId.value)
    }
  )

  ipcMain.handle(
    'linear:restoreIssueLabel',
    async (_event, args: { id?: string; workspaceId?: string }) => {
      const id = normalizeWorkspaceId(args?.id)
      if (!id) {
        return { ok: false, error: 'Label ID is required' }
      }
      const workspaceId = normalizeOptionalWorkspaceId((args ?? {}) as Record<string, unknown>)
      if (!workspaceId.ok) {
        return workspaceId
      }
      return restoreIssueLabel(id, workspaceId.value)
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
