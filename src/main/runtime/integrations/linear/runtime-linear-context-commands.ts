import { clampLinearIssueListLimit } from '../../../../shared/linear/issue-read-limits'
import { addIssueComment as addLinearIssueComment } from '../../../linear/issues/linear-issue-comments'
import {
  createIssue as createLinearIssue,
  updateIssue as updateLinearIssue
} from '../../../linear/issues/linear-issue-mutations'
import { getIssue as getLinearIssue } from '../../../linear/issues/linear-issue-lookups'
import { listIssues as listLinearIssues } from '../../../linear/issues/linear-issue-listing'
import type { LinearIssueUpdate } from '../../../../shared/issue-mutation-types'
import type { LinearWorkspaceSelection } from '../../../../shared/linear/workspace-types'
import type { LinearListFilter } from '../../../linear/issues/linear-issue-listing'
import type { LinearIssueListOptions } from '../../../linear/issues/linear-issue-query-documents'
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
