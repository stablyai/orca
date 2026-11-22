import { defineMethod } from '../core'
import {
  AddCommentSchema,
  ConnectSchema,
  CreateIssueSchema,
  GetIssueSchema,
  ListIssuesSchema,
  ListStatesSchema,
  SelectWorkspaceSchema,
  SetPrioritySchema,
  SetStateSchema,
  WorkspaceSelection
} from '../../../../shared/rpc-contract/plane-params'
import { connect, disconnect, getClient, getStatus, selectWorkspace, testConnection } from '../../../plane/client'
import {
  addIssueComment,
  createIssue,
  getIssue,
  getIssueComments,
  listIssues,
  listProjects,
  listStates,
  updateIssue
} from '../../../plane/issues'
import {
  resolvePlaneIssueTarget,
  resolvePlaneStateTarget
} from '../../../plane/issue-resolution'

export const PLANE_METHODS = [
  defineMethod({
    name: 'plane.status',
    permission: 'workspace',
    params: null,
    handler: async () => getStatus()
  }),
  defineMethod({
    name: 'plane.connect',
    permission: 'accounts-admin',
    params: ConnectSchema,
    handler: async (params) =>
      connect({
        apiToken: params.apiKey,
        instanceUrl: params.baseUrl ?? 'https://api.plane.so',
        instanceType: params.authType === 'self-hosted' ? 'self_hosted' : 'cloud'
      })
  }),
  defineMethod({
    name: 'plane.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async () => {
      disconnect()
      return getStatus()
    }
  }),
  defineMethod({
    name: 'plane.selectWorkspace',
    permission: 'accounts-admin',
    params: SelectWorkspaceSchema,
    handler: async (params) => selectWorkspace(params.slug)
  }),
  defineMethod({
    name: 'plane.testConnection',
    permission: 'workspace',
    params: null,
    handler: async () => testConnection()
  }),
  defineMethod({
    name: 'plane.listProjects',
    permission: 'workspace',
    params: WorkspaceSelection,
    handler: async (params) => listProjects(params?.workspaceSlug)
  }),
  defineMethod({
    name: 'plane.listStates',
    permission: 'workspace',
    params: ListStatesSchema,
    handler: async (params) => {
      const slug = params.workspaceSlug || getClient()?.activeWorkspaceSlug
      if (!slug) {
        throw new Error('No Plane workspace specified and no active workspace selected')
      }
      return listStates(slug, params.projectId)
    }
  }),
  defineMethod({
    name: 'plane.listIssues',
    permission: 'workspace',
    params: ListIssuesSchema,
    handler: async (params) => listIssues(params ?? {})
  }),
  defineMethod({
    name: 'plane.getIssue',
    permission: 'workspace',
    params: GetIssueSchema,
    handler: async (params) => {
      const target = await resolvePlaneIssueTarget(
        params.id,
        params.workspaceSlug,
        params.projectId
      )
      const issue =
        target.issue ??
        (await getIssue(target.workspaceSlug, target.projectId, target.issueId))
      if (!issue) {
        throw new Error(`Plane issue not found: ${params.id}`)
      }
      const comments = params.includeComments
        ? await getIssueComments(target.workspaceSlug, target.projectId, target.issueId)
        : undefined
      return { issue, comments }
    }
  }),
  defineMethod({
    name: 'plane.createIssue',
    permission: 'workspace',
    params: CreateIssueSchema,
    handler: async (params) => {
      const result = await createIssue({
        title: params.title,
        projectId: params.projectId,
        description: params.description,
        stateId: params.stateId,
        priority: params.priority,
        workspaceSlug: params.workspaceSlug
      })
      if (!result.ok || !result.issue) {
        throw new Error(result.error ?? 'Failed to create Plane issue')
      }
      return result.issue
    }
  }),
  defineMethod({
    name: 'plane.issueSetState',
    permission: 'workspace',
    params: SetStateSchema,
    handler: async (params) => {
      const target = await resolvePlaneIssueTarget(
        params.id,
        params.workspaceSlug,
        params.projectId
      )
      const state = await resolvePlaneStateTarget(
        target.workspaceSlug,
        target.projectId,
        params.to
      )
      const result = await updateIssue({
        workspaceSlug: target.workspaceSlug,
        projectId: target.projectId,
        issueId: target.issueId,
        update: { stateId: state.id }
      })
      if (!result.ok) {
        throw new Error(result.error ?? 'Failed to update Plane issue status')
      }
      return { ok: true, issueId: target.issueId, state }
    }
  }),
  defineMethod({
    name: 'plane.issueSetPriority',
    permission: 'workspace',
    params: SetPrioritySchema,
    handler: async (params) => {
      const target = await resolvePlaneIssueTarget(
        params.id,
        params.workspaceSlug,
        params.projectId
      )
      const result = await updateIssue({
        workspaceSlug: target.workspaceSlug,
        projectId: target.projectId,
        issueId: target.issueId,
        update: { priority: params.priority }
      })
      if (!result.ok) {
        throw new Error(result.error ?? 'Failed to update Plane issue priority')
      }
      return { ok: true, issueId: target.issueId, priority: params.priority }
    }
  }),
  defineMethod({
    name: 'plane.issueAddComment',
    permission: 'workspace',
    params: AddCommentSchema,
    handler: async (params) => {
      const target = await resolvePlaneIssueTarget(
        params.id,
        params.workspaceSlug,
        params.projectId
      )
      const result = await addIssueComment(
        target.workspaceSlug,
        target.projectId,
        target.issueId,
        params.body
      )
      if (!result.ok) {
        throw new Error(result.error ?? 'Failed to add comment to Plane issue')
      }
      return { ok: true, issueId: target.issueId }
    }
  })
]
