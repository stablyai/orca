import {
  clampLinearIssueListLimit,
  addLinearIssueComment,
  createLinearIssue,
  getLinearIssue,
  listLinearIssues,
  updateLinearIssue
} from './runtime-linear-command-dependencies'
import type {
  LinearIssueUpdate,
  LinearWorkspaceSelection,
  LinearListFilter,
  LinearIssueListOptions
} from './runtime-linear-command-dependencies'
import { RuntimeLinearStateCommands } from './runtime-linear-state-commands'

export class RuntimeLinearContextCommands extends RuntimeLinearStateCommands {
  linearListIssues(
    filter?: LinearListFilter,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection,
    options?: LinearIssueListOptions
  ): ReturnType<typeof listLinearIssues> {
    return listLinearIssues(filter, clampLinearIssueListLimit(limit), workspaceId, options)
  }

  linearCreateIssue(
    teamId: string,
    title: string,
    description?: string,
    workspaceId?: string,
    parentIssueId?: string,
    projectId?: string | null,
    options?: {
      stateId?: string
      priority?: number
      estimate?: number | null
      dueDate?: string | null
      assigneeId?: string | null
      labelIds?: string[]
    }
  ): ReturnType<typeof createLinearIssue> {
    return createLinearIssue(teamId, title, description, workspaceId, {
      parentId: parentIssueId,
      projectId,
      ...options
    })
  }

  linearGetIssue(id: string, workspaceId?: string): ReturnType<typeof getLinearIssue> {
    return getLinearIssue(id, workspaceId)
  }

  linearUpdateIssue(
    id: string,
    updates: LinearIssueUpdate,
    workspaceId?: string
  ): ReturnType<typeof updateLinearIssue> {
    return updateLinearIssue(id, updates, workspaceId)
  }

  linearAddIssueComment(
    issueId: string,
    body: string,
    workspaceId?: string
  ): ReturnType<typeof addLinearIssueComment> {
    return addLinearIssueComment(issueId, body, workspaceId)
  }
}
