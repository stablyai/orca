import { ipcMain } from 'electron'
import {
  getCustomView,
  listCustomViewIssues,
  listCustomViewProjects,
  listCustomViews
} from '../linear/projects'
import {
  normalizeConcreteWorkspaceId,
  normalizeCustomViewModel,
  normalizeWorkspaceSelection
} from './linear-ipc-args'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import type { LinearCustomViewModel } from '../../shared/linear/project-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

export function registerLinearCustomViewHandlers(): void {
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
}
