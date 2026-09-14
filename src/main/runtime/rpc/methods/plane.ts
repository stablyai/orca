import { z } from 'zod'
import { defineMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
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

const PlanePriority = z.enum(['none', 'urgent', 'high', 'medium', 'low'])

const ConnectSchema = z.object({
  apiKey: requiredString('API token is required'),
  baseUrl: OptionalString,
  authType: z.enum(['cloud', 'self-hosted']).optional()
})

const SelectWorkspaceSchema = z.object({
  slug: requiredString('Workspace slug is required')
})

const WorkspaceSelection = z
  .object({
    workspaceSlug: OptionalString
  })
  .optional()

const ListStatesSchema = z.object({
  projectId: requiredString('Project ID is required'),
  workspaceSlug: OptionalString
})

const ListIssuesSchema = z
  .object({
    workspaceSlug: OptionalString,
    projectId: OptionalString,
    limit: OptionalFiniteNumber
  })
  .optional()

const GetIssueSchema = z.object({
  id: requiredString('Issue ID is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString,
  includeComments: z.boolean().optional()
})

const CreateIssueSchema = z.object({
  title: requiredString('Title is required'),
  projectId: requiredString('Project is required'),
  description: OptionalString,
  stateId: OptionalString,
  priority: PlanePriority.optional(),
  workspaceSlug: OptionalString
})

const SetStateSchema = z.object({
  id: requiredString('Issue ID is required'),
  to: requiredString('State is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString
})

const SetPrioritySchema = z.object({
  id: requiredString('Issue ID is required'),
  priority: PlanePriority,
  workspaceSlug: OptionalString,
  projectId: OptionalString
})

const AddCommentSchema = z.object({
  id: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  workspaceSlug: OptionalString,
  projectId: OptionalString
})

export const PLANE_METHODS = [
  defineMethod({
    name: 'plane.status',
    params: null,
    handler: async () => getStatus()
  }),
  defineMethod({
    name: 'plane.connect',
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
    params: null,
    handler: async () => {
      disconnect()
      return getStatus()
    }
  }),
  defineMethod({
    name: 'plane.selectWorkspace',
    params: SelectWorkspaceSchema,
    handler: async (params) => selectWorkspace(params.slug)
  }),
  defineMethod({
    name: 'plane.testConnection',
    params: null,
    handler: async () => testConnection()
  }),
  defineMethod({
    name: 'plane.listProjects',
    params: WorkspaceSelection,
    handler: async (params) => listProjects(params?.workspaceSlug)
  }),
  defineMethod({
    name: 'plane.listStates',
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
    params: ListIssuesSchema,
    handler: async (params) => listIssues(params ?? {})
  }),
  defineMethod({
    name: 'plane.getIssue',
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
    params: CreateIssueSchema,
    handler: async (params) => {
      const result = await createIssue(params)
      if (!result.ok || !result.issue) {
        throw new Error(result.error ?? 'Failed to create Plane issue')
      }
      return result.issue
    }
  }),
  defineMethod({
    name: 'plane.issueSetState',
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
