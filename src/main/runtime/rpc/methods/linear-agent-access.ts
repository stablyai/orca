import { defineMethod } from '../core'
import { linearError } from '../../../linear/issue-context-errors'
import { isLinearUuid } from '../../../../shared/linear/uuid'
import {
  AgentIssueContext,
  AgentSearchIssues,
  LinearCurrentContext,
  LinearIssueAddComment,
  LinearIssueAttachLink,
  LinearIssueCreate,
  LinearIssueList,
  LinearIssueRelationWrite,
  LinearIssueSetState,
  LinearIssueUpdateTask,
  LinearProjectList,
  LinearSaveIssue,
  LinearTeamLookup,
  LinearWorkspaceRead
} from '../../../../shared/rpc-contract/linear-agent-access-params'

function parseLinearWriteId(writeId: string | undefined): string | undefined {
  if (writeId === undefined) {
    return undefined
  }
  if (!isLinearUuid(writeId)) {
    throw linearError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

export const LINEAR_AGENT_ACCESS_METHODS = [
  defineMethod({
    name: 'linear.saveIssue',
    permission: 'workspace',
    params: LinearSaveIssue,
    handler: async (params, { runtime }) =>
      runtime.linearSaveIssue({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.agentSearchIssues',
    permission: 'workspace',
    params: AgentSearchIssues,
    handler: async (params, { runtime }) =>
      runtime.linearSearchForAgents({
        query: params.query,
        limit: params.limit,
        workspaceId: params.workspaceId
      })
  }),
  defineMethod({
    name: 'linear.issueContext',
    permission: 'workspace',
    params: AgentIssueContext,
    handler: async (params, { runtime }) => runtime.linearIssueContext(params)
  }),
  defineMethod({
    name: 'linear.agentTeamList',
    permission: 'workspace',
    params: LinearWorkspaceRead,
    handler: async (params, { runtime }) => runtime.linearTeamListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamMembers',
    permission: 'workspace',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamMembersForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamStates',
    permission: 'workspace',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamStatesForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamLabels',
    permission: 'workspace',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamLabelsForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentIssueList',
    permission: 'workspace',
    params: LinearIssueList,
    handler: async (params, { runtime }) => runtime.linearIssueListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentProjectList',
    permission: 'workspace',
    params: LinearProjectList,
    handler: async (params, { runtime }) => runtime.linearProjectListForAgents(params)
  }),
  defineMethod({
    name: 'linear.resolveCurrentIssue',
    permission: 'workspace',
    params: LinearCurrentContext,
    handler: async (params, { runtime }) => runtime.linearResolveCurrentIssue(params)
  }),
  defineMethod({
    name: 'linear.issueSetState',
    permission: 'workspace',
    params: LinearIssueSetState,
    handler: async (params, { runtime }) => runtime.linearIssueSetState(params)
  }),
  defineMethod({
    name: 'linear.issueUpdateTask',
    permission: 'workspace',
    params: LinearIssueUpdateTask,
    handler: async (params, { runtime }) => runtime.linearIssueUpdateTask(params)
  }),
  defineMethod({
    name: 'linear.issueRelationWrite',
    permission: 'workspace',
    params: LinearIssueRelationWrite,
    handler: async (params, { runtime }) => runtime.linearIssueRelationWrite(params)
  }),
  defineMethod({
    name: 'linear.issueAddComment',
    permission: 'workspace',
    params: LinearIssueAddComment,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAddComment({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueAttachLink',
    permission: 'workspace',
    params: LinearIssueAttachLink,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAttachLink({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueCreate',
    permission: 'workspace',
    params: LinearIssueCreate,
    handler: async (params, { runtime }) =>
      runtime.linearIssueCreate({ ...params, writeId: parseLinearWriteId(params.writeId) })
  })
]
