import type { PlaneConnectArgs, PlaneWorkspaceSelection } from '../../shared/plane-types'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../plane/client'
import {
  planeAddComment,
  planeCreateWorkItem,
  planeGetWorkItem,
  planeListLabels,
  planeListMembers,
  planeListProjects,
  planeListStates,
  planeListWorkItems,
  planeSearchWorkItems,
  planeUpdateWorkItem,
  planeWorkItemComments,
  type PlaneProjectScope
} from '../plane/provider-operations'

export class RuntimePlaneCommands {
  planeConnect(args: PlaneConnectArgs): ReturnType<typeof connect> {
    return connect(args)
  }

  planeDisconnect(workspaceId?: string): { ok: true } {
    disconnect(workspaceId)
    return { ok: true }
  }

  planeStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  planeSelectWorkspace(workspaceId: string): ReturnType<typeof selectWorkspace> {
    return selectWorkspace(workspaceId as PlaneWorkspaceSelection)
  }

  planeTestConnection(workspaceId?: string): ReturnType<typeof testConnection> {
    return testConnection(workspaceId)
  }

  planeListProjects(workspaceId?: string): ReturnType<typeof planeListProjects> {
    return planeListProjects(workspaceId)
  }

  planeListStates(projectId: string, workspaceId?: string): ReturnType<typeof planeListStates> {
    return planeListStates(projectId, workspaceId)
  }

  planeListLabels(projectId: string, workspaceId?: string): ReturnType<typeof planeListLabels> {
    return planeListLabels(projectId, workspaceId)
  }

  planeListMembers(workspaceId?: string): ReturnType<typeof planeListMembers> {
    return planeListMembers(workspaceId)
  }

  planeListWorkItems(
    args: PlaneProjectScope & { orderBy?: string; limit?: number }
  ): ReturnType<typeof planeListWorkItems> {
    return planeListWorkItems(args)
  }

  planeGetWorkItem(
    args: Parameters<typeof planeGetWorkItem>[0]
  ): ReturnType<typeof planeGetWorkItem> {
    return planeGetWorkItem(args)
  }

  planeSearchWorkItems(
    args: Parameters<typeof planeSearchWorkItems>[0]
  ): ReturnType<typeof planeSearchWorkItems> {
    return planeSearchWorkItems(args)
  }

  planeWorkItemComments(
    args: PlaneProjectScope & { workItemId: string }
  ): ReturnType<typeof planeWorkItemComments> {
    return planeWorkItemComments(args)
  }

  planeUpdateWorkItem(
    args: Parameters<typeof planeUpdateWorkItem>[0]
  ): ReturnType<typeof planeUpdateWorkItem> {
    return planeUpdateWorkItem(args)
  }

  planeAddComment(
    args: PlaneProjectScope & { workItemId: string; body: string }
  ): ReturnType<typeof planeAddComment> {
    return planeAddComment(args)
  }

  planeCreateWorkItem(
    args: Parameters<typeof planeCreateWorkItem>[0]
  ): ReturnType<typeof planeCreateWorkItem> {
    return planeCreateWorkItem(args)
  }
}
