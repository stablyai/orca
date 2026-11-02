import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../plane/client'
import {
  addIssueComment,
  getIssue,
  getIssueComments,
  listIssues,
  listProjects,
  listStates,
  updateIssue
} from '../plane/issues'
import type {
  PlaneConnectArgs,
  PlaneIssueFilter,
  PlaneIssueUpdate
} from '../../shared/plane-types'

export function registerPlaneHandlers(): void {
  ipcMain.handle('plane:connect', async (_event, args: PlaneConnectArgs) => {
    return connect(args)
  })

  ipcMain.handle('plane:disconnect', async () => {
    disconnect()
    return getStatus()
  })

  ipcMain.handle('plane:status', async () => {
    return getStatus()
  })

  ipcMain.handle('plane:testConnection', async () => {
    return testConnection()
  })

  ipcMain.handle('plane:selectWorkspace', async (_event, args: { workspaceSlug: string }) => {
    return selectWorkspace(args.workspaceSlug)
  })

  ipcMain.handle('plane:listProjects', async (_event, args?: { workspaceSlug?: string }) => {
    return listProjects(args?.workspaceSlug)
  })

  ipcMain.handle(
    'plane:listStates',
    async (_event, args: { workspaceSlug: string; projectId: string }) => {
      return listStates(args.workspaceSlug, args.projectId)
    }
  )

  ipcMain.handle(
    'plane:listIssues',
    async (
      _event,
      args?: {
        workspaceSlug?: string
        projectId?: string
        filter?: PlaneIssueFilter
        limit?: number
      }
    ) => {
      return listIssues(args ?? {})
    }
  )

  ipcMain.handle(
    'plane:getIssue',
    async (_event, args: { workspaceSlug: string; projectId: string; issueId: string }) => {
      return getIssue(args.workspaceSlug, args.projectId, args.issueId)
    }
  )

  ipcMain.handle(
    'plane:updateIssue',
    async (
      _event,
      args: {
        workspaceSlug: string
        projectId: string
        issueId: string
        update: PlaneIssueUpdate
      }
    ) => {
      return updateIssue(args)
    }
  )

  ipcMain.handle(
    'plane:getIssueComments',
    async (_event, args: { workspaceSlug: string; projectId: string; issueId: string }) => {
      return getIssueComments(args.workspaceSlug, args.projectId, args.issueId)
    }
  )

  ipcMain.handle(
    'plane:addIssueComment',
    async (
      _event,
      args: {
        workspaceSlug: string
        projectId: string
        issueId: string
        comment: string
      }
    ) => {
      return addIssueComment(args.workspaceSlug, args.projectId, args.issueId, args.comment)
    }
  )
}
