import { ipcMain } from 'electron'
import {
  getIssue,
  searchIssues,
  listIssues,
  createIssue,
  updateIssue,
  addIssueComment,
  getIssueComments
} from '../linear/issues'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './linear-ipc-args'
import type { LinearListFilter } from '../linear/issues'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import { optionalParsedLinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import type { LinearIssueUpdate } from '../../shared/issue-mutation-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

const VALID_FILTERS = new Set<LinearListFilter>(['assigned', 'created', 'all', 'completed'])

export function registerLinearIssueHandlers(): void {
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
}
