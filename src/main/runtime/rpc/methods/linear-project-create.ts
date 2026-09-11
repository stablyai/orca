import { defineMethod, type RpcMethod } from '../core'
import { CreateProject } from '../../../../shared/rpc-contract/linear-project-create-params'

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
