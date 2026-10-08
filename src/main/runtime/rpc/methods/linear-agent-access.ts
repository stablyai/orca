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
    params: LinearSaveIssue,
    handler: async (params, { runtime }) =>
      runtime.linearSaveIssue({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.agentSearchIssues',
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
    params: AgentIssueContext,
    handler: async (params, { runtime }) => runtime.linearIssueContext(params)
  }),
  defineMethod({
    name: 'linear.agentTeamList',
    params: LinearWorkspaceRead,
    handler: async (params, { runtime }) => runtime.linearTeamListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamMembers',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamMembersForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamStates',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamStatesForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamLabels',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamLabelsForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentIssueList',
    params: LinearIssueList,
    handler: async (params, { runtime }) => runtime.linearIssueListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentProjectList',
    params: LinearProjectList,
    handler: async (params, { runtime }) => runtime.linearProjectListForAgents(params)
  }),
  defineMethod({
    name: 'linear.resolveCurrentIssue',
    params: LinearCurrentContext,
    handler: async (params, { runtime }) => runtime.linearResolveCurrentIssue(params)
  }),
  defineMethod({
    name: 'linear.issueSetState',
    params: LinearIssueSetState,
    handler: async (params, { runtime }) => runtime.linearIssueSetState(params)
  }),
  defineMethod({
    name: 'linear.issueUpdateTask',
    params: LinearIssueUpdateTask,
    handler: async (params, { runtime }) => runtime.linearIssueUpdateTask(params)
  }),
  defineMethod({
    name: 'linear.issueRelationWrite',
    params: LinearIssueRelationWrite,
    handler: async (params, { runtime }) => runtime.linearIssueRelationWrite(params)
  }),
  defineMethod({
    name: 'linear.issueAddComment',
    params: LinearIssueAddComment,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAddComment({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueAttachLink',
    params: LinearIssueAttachLink,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAttachLink({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueCreate',
    params: LinearIssueCreate,
    handler: async (params, { runtime }) =>
      runtime.linearIssueCreate({ ...params, writeId: parseLinearWriteId(params.writeId) })
  })
]
