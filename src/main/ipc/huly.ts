/* eslint-disable max-lines -- Why: Huly IPC validates one namespace in one
   registration boundary so local and SSH runtime schemas can stay mirrored. */
import { ipcMain } from 'electron'
import {
  connect,
  disconnect,
  getStatus,
  selectConnection,
  getPreflightStatus
} from '../huly/client'
import {
  listIssues,
  searchIssues,
  getIssue,
  createIssue,
  updateIssue,
  addComment,
  listComments
} from '../huly/issues'
import { listProjects, getProject, createProject, listProjectIssues } from '../huly/projects'
import { listTeams, getTeamMembers, getTeamStates, getTeamLabels } from '../huly/teams'
import type { HulyConnectionSelection, HulyIssueUpdate, HulyListFilter } from '../../shared/types'

const VALID_FILTERS = new Set<HulyListFilter>(['assigned', 'created', 'all'])

function normalizeConnectionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeConnectionSelection(value: unknown): HulyConnectionSelection | undefined {
  const id = normalizeConnectionId(value)
  return id as HulyConnectionSelection | undefined
}

export function registerHulyHandlers(): void {
  ipcMain.handle(
    'huly:connect',
    async (
      _event,
      args: {
        name: string
        url: string
        workspace: string
        email: string | null
        secret: string
      }
    ) => {
      if (typeof args?.name !== 'string' || !args.name.trim()) {
        return { ok: false, error: 'Connection name is required' }
      }
      if (typeof args?.url !== 'string' || !args.url.trim()) {
        return { ok: false, error: 'Huly URL is required' }
      }
      if (typeof args?.workspace !== 'string' || !args.workspace.trim()) {
        return { ok: false, error: 'Workspace is required' }
      }
      if (typeof args?.secret !== 'string' || !args.secret.trim()) {
        return { ok: false, error: 'A token or password is required' }
      }
      return connect({
        name: args.name.trim(),
        url: args.url.trim(),
        workspace: args.workspace.trim(),
        email: typeof args.email === 'string' && args.email.trim() ? args.email.trim() : null,
        secret: args.secret.trim()
      })
    }
  )

  ipcMain.handle('huly:disconnect', async (_event, args?: { connectionId?: string }) => {
    disconnect(normalizeConnectionId(args?.connectionId))
    return getStatus()
  })

  ipcMain.handle('huly:selectConnection', async (_event, args: { connectionId: string }) => {
    const id = normalizeConnectionSelection(args?.connectionId)
    if (!id) {
      return getStatus()
    }
    return selectConnection(id)
  })

  ipcMain.handle('huly:status', async () => getStatus())

  ipcMain.handle('huly:preflight', async () => getPreflightStatus())

  ipcMain.handle(
    'huly:listIssues',
    async (
      _event,
      args?: {
        filter?: HulyListFilter
        limit?: number
        connectionId?: HulyConnectionSelection
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as HulyListFilter)
        ? (args!.filter as HulyListFilter)
        : undefined
      const limit = Math.min(Math.max(1, args?.limit ?? 50), 200)
      return listIssues(filter, limit, normalizeConnectionId(args?.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:searchIssues',
    async (
      _event,
      args: {
        query: string
        limit?: number
        connectionId?: HulyConnectionSelection
      }
    ) => {
      if (typeof args?.query !== 'string' || !args.query.trim()) {
        return []
      }
      const limit = Math.min(Math.max(1, args.limit ?? 20), 50)
      return searchIssues(
        args.query.trim(),
        limit,
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:getIssue',
    async (
      _event,
      args: {
        id: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return null
      }
      return getIssue(args.id.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:createIssue',
    async (
      _event,
      args: {
        teamId: string
        title: string
        description?: string
        priority?: number
        stateId?: string
        assigneeId?: string | null
        labelIds?: string[]
        projectId?: string | null
        connectionId?: string
      }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return { ok: false, error: 'Team ID is required' }
      }
      if (typeof args?.title !== 'string' || !args.title.trim()) {
        return { ok: false, error: 'Title is required' }
      }
      return createIssue(
        {
          teamId: args.teamId.trim(),
          title: args.title.trim(),
          description: args.description?.trim() || undefined,
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          stateId: typeof args.stateId === 'string' ? args.stateId.trim() : undefined,
          assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId.trim() : null,
          labelIds: Array.isArray(args.labelIds)
            ? args.labelIds.map((id) => id.trim()).filter(Boolean)
            : undefined,
          projectId: typeof args.projectId === 'string' ? args.projectId.trim() : null
        },
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:updateIssue',
    async (
      _event,
      args: {
        id: string
        updates: HulyIssueUpdate
        connectionId?: string
      }
    ) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      return updateIssue(
        args.id.trim(),
        args.updates ?? {},
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:addComment',
    async (
      _event,
      args: {
        issueId: string
        body: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.issueId !== 'string' || !args.issueId.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required' }
      }
      return addComment(
        args.issueId.trim(),
        args.body.trim(),
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:listComments',
    async (
      _event,
      args: {
        issueId: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.issueId !== 'string' || !args.issueId.trim()) {
        return []
      }
      return listComments(args.issueId.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:listProjects',
    async (
      _event,
      args?: {
        query?: string
        limit?: number
        connectionId?: HulyConnectionSelection
      }
    ) => {
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listProjects(
        typeof args?.query === 'string' ? args.query : undefined,
        limit,
        normalizeConnectionId(args?.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:getProject',
    async (
      _event,
      args: {
        id: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('Project ID is required')
      }
      return getProject(args.id.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:createProject',
    async (
      _event,
      args: {
        name: string
        description?: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.name !== 'string' || !args.name.trim()) {
        return { ok: false, error: 'Project name is required' }
      }
      return createProject(
        { name: args.name.trim(), description: args.description?.trim() || undefined },
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:listProjectIssues',
    async (
      _event,
      args: {
        projectId: string
        limit?: number
        connectionId?: string
      }
    ) => {
      if (typeof args?.projectId !== 'string' || !args.projectId.trim()) {
        throw new Error('Project ID is required')
      }
      const limit = Math.min(Math.max(1, args.limit ?? 50), 200)
      return listProjectIssues(
        args.projectId.trim(),
        limit,
        normalizeConnectionId(args.connectionId) ?? null
      )
    }
  )

  ipcMain.handle(
    'huly:listTeams',
    async (
      _event,
      args?: {
        connectionId?: HulyConnectionSelection
      }
    ) => listTeams(normalizeConnectionId(args?.connectionId) ?? null)
  )

  ipcMain.handle(
    'huly:teamMembers',
    async (
      _event,
      args: {
        teamId: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamMembers(args.teamId.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:teamStates',
    async (
      _event,
      args: {
        teamId: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamStates(args.teamId.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )

  ipcMain.handle(
    'huly:teamLabels',
    async (
      _event,
      args: {
        teamId: string
        connectionId?: string
      }
    ) => {
      if (typeof args?.teamId !== 'string' || !args.teamId.trim()) {
        return []
      }
      return getTeamLabels(args.teamId.trim(), normalizeConnectionId(args.connectionId) ?? null)
    }
  )
}
