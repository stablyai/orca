import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const LinearPriority = z.number().int().min(0).max(4).optional()
const LinearLabelIds = z.array(requiredString('Invalid label ID')).optional()

const CreateProject = z.object({
  name: requiredString('Project name is required'),
  description: OptionalString,
  content: OptionalString,
  workspaceId: OptionalString,
  teamIds: z.array(requiredString('Invalid team ID')).min(1, 'At least one team is required'),
  leadId: z.union([z.string(), z.null()]).optional(),
  memberIds: z.array(requiredString('Invalid member ID')).optional(),
  labelIds: LinearLabelIds,
  priority: LinearPriority,
  startDate: OptionalString,
  targetDate: OptionalString
})

export const LINEAR_PROJECT_CREATE_METHOD: RpcMethod = defineMethod({
  name: 'linear.createProject',
  params: CreateProject,
  handler: async (params, { runtime }) =>
    runtime.linearCreateProject(
      {
        name: params.name.trim(),
        description: params.description?.trim() || undefined,
        content: params.content?.trim() || undefined,
        teamIds: params.teamIds.map((id) => id.trim()),
        leadId: params.leadId ? params.leadId.trim() : undefined,
        memberIds: params.memberIds?.map((id) => id.trim()),
        labelIds: params.labelIds?.map((id) => id.trim()),
        priority: params.priority,
        startDate: params.startDate?.trim() || undefined,
        targetDate: params.targetDate?.trim() || undefined
      },
      params.workspaceId
    )
})
