import { ipcMain } from 'electron'
import { createProject, getProject, listProjectIssues, listProjects } from '../linear/projects'
import {
  normalizeConcreteWorkspaceId,
  normalizeIdList,
  normalizeOptionalDate,
  normalizeWorkspaceId,
  normalizeWorkspaceSelection
} from './linear-ipc-args'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

export function registerLinearProjectHandlers(): void {
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
}
