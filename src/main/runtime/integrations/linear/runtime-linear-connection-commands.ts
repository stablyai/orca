import {
  connect as connectLinear,
  disconnect as disconnectLinear,
  getStatus as getLinearStatus,
  selectWorkspace as selectLinearWorkspace,
  testConnection as testLinearConnection
} from '../../../linear/client'
import { searchIssues as searchLinearIssues } from '../../../linear/linear-issue-lookups'
import { readLinearIssueContext } from '../../../linear/issue-context/read-context'
import { searchLinearIssuesForAgents } from '../../../linear/issue-context/client'
import type { LinearIssueRequest } from '../../../../shared/linear/agent-access'
import type { LinearWorkspaceSelection } from '../../../../shared/linear/workspace-types'
import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'

export class RuntimeLinearCommands extends RuntimeLinearReadCommands {
  linearConnect(apiKey: string): ReturnType<typeof connectLinear> {
    return connectLinear(apiKey)
  }

  linearDisconnect(workspaceId?: string): { ok: true } {
    disconnectLinear(workspaceId)
    return { ok: true }
  }

  linearSelectWorkspace(workspaceId: LinearWorkspaceSelection): ReturnType<typeof getLinearStatus> {
    return selectLinearWorkspace(workspaceId)
  }

  linearStatus(): ReturnType<typeof getLinearStatus> {
    return getLinearStatus()
  }

  linearTestConnection(workspaceId?: string): ReturnType<typeof testLinearConnection> {
    return testLinearConnection(workspaceId)
  }

  linearSearchIssues(
    query: string,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection
  ): ReturnType<typeof searchLinearIssues> {
    return searchLinearIssues(query, Math.min(Math.max(1, limit), 50), workspaceId)
  }

  linearSearchForAgents(args: {
    query: string
    limit?: number
    workspaceId?: (string & {}) | 'all'
  }): ReturnType<typeof searchLinearIssuesForAgents> {
    return searchLinearIssuesForAgents(args)
  }

  linearIssueContext(request: LinearIssueRequest): ReturnType<typeof readLinearIssueContext> {
    return readLinearIssueContext(request, (context) => this.linearResolveCurrentIssue(context))
  }
}
