import {
  getLinearAttachmentByUuidForAgent,
  getLinearCommentByUuidForAgent,
  getLinearIssueByUuidForAgent,
  LinearAgentAccessError,
  linearError,
  sanitizeLinearErrorMessage,
  sameStringSet
} from './runtime-linear-command-dependencies'
import type { LinearCreateFieldIntent } from './runtime-linear-command-dependencies'
import { RuntimeLinearCommentLookupCommands } from './runtime-linear-comment-lookup-commands'

export class RuntimeLinearDedupeCommands extends RuntimeLinearCommentLookupCommands {
  public async getMatchingLinearCommentWrite(
    writeId: string,
    issueId: string,
    parentId: string | null,
    workspaceId: string,
    required: boolean
  ): Promise<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>> | null> {
    const comment = await this.readLinearWriteLookup(() =>
      getLinearCommentByUuidForAgent(writeId, workspaceId)
    )
    if (!comment) {
      return null
    }
    if (comment.issue.id === issueId && comment.parentId === parentId) {
      return comment
    }
    if (required) {
      throw linearError(
        'linear_invalid_write_id',
        'The write id belongs to a different comment target.'
      )
    }
    return null
  }

  public async getMatchingLinearAttachmentWrite(
    writeId: string,
    issueId: string,
    workspaceId: string,
    required: boolean
  ): Promise<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>> | null> {
    const attachment = await this.readLinearWriteLookup(() =>
      getLinearAttachmentByUuidForAgent(writeId, workspaceId)
    )
    if (!attachment) {
      return null
    }
    if (attachment.issue.id === issueId) {
      return attachment
    }
    if (required) {
      throw linearError(
        'linear_invalid_write_id',
        'The write id belongs to a different attachment target.'
      )
    }
    return null
  }

  public async getMatchingLinearCreatedIssue(
    writeId: string,
    teamId: string,
    parentId: string | null,
    workspaceId: string,
    required: boolean,
    intent: LinearCreateFieldIntent = {}
  ): Promise<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>> | null> {
    const issue = await this.readLinearWriteLookup(() =>
      getLinearIssueByUuidForAgent(writeId, workspaceId)
    )
    if (!issue) {
      return null
    }
    if (
      issue.team.id === teamId &&
      (issue.parent?.id ?? null) === parentId &&
      this.linearCreatedIssueMatchesIntent(issue, intent)
    ) {
      return issue
    }
    if (required) {
      throw linearError(
        'linear_invalid_write_id',
        'The write id belongs to a different issue target.'
      )
    }
    return null
  }

  public async refetchLinearCommentAfterDuplicate(
    writeId: string,
    issueId: string,
    parentId: string | null,
    workspaceId: string,
    unconfirmed: (cause?: string) => LinearAgentAccessError
  ): Promise<NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>> {
    try {
      // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
      const comment = await this.getMatchingLinearCommentWrite(
        writeId,
        issueId,
        parentId,
        workspaceId,
        true
      )
      if (comment) {
        return comment
      }
    } catch (error) {
      if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
        throw error
      }
      throw unconfirmed(
        error instanceof Error
          ? sanitizeLinearErrorMessage(error.message)
          : sanitizeLinearErrorMessage(String(error))
      )
    }
    throw unconfirmed()
  }

  public async refetchLinearAttachmentAfterDuplicate(
    writeId: string,
    issueId: string,
    workspaceId: string,
    unconfirmed: (cause?: string) => LinearAgentAccessError
  ): Promise<NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>> {
    try {
      // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
      const attachment = await this.getMatchingLinearAttachmentWrite(
        writeId,
        issueId,
        workspaceId,
        true
      )
      if (attachment) {
        return attachment
      }
    } catch (error) {
      if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
        throw error
      }
      throw unconfirmed(
        error instanceof Error
          ? sanitizeLinearErrorMessage(error.message)
          : sanitizeLinearErrorMessage(String(error))
      )
    }
    throw unconfirmed()
  }

  public async refetchLinearIssueAfterDuplicate(
    writeId: string,
    teamId: string,
    parentId: string | null,
    workspaceId: string,
    intent: LinearCreateFieldIntent,
    unconfirmed: (cause?: string) => LinearAgentAccessError
  ): Promise<NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>> {
    try {
      // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
      const issue = await this.getMatchingLinearCreatedIssue(
        writeId,
        teamId,
        parentId,
        workspaceId,
        true,
        intent
      )
      if (issue) {
        return issue
      }
    } catch (error) {
      if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
        throw error
      }
      throw unconfirmed(
        error instanceof Error
          ? sanitizeLinearErrorMessage(error.message)
          : sanitizeLinearErrorMessage(String(error))
      )
    }
    throw unconfirmed()
  }

  public async readLinearWriteLookup<T>(lookup: () => Promise<T>): Promise<T> {
    try {
      return await lookup()
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
  public linearCreatedIssueMatchesIntent(
    issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    intent: LinearCreateFieldIntent
  ): boolean {
    if (intent.stateId !== undefined && issue.state?.id !== intent.stateId) {
      return false
    }
    if (intent.assigneeId !== undefined && (issue.assignee?.id ?? null) !== intent.assigneeId) {
      return false
    }
    if (intent.priority !== undefined && issue.priority !== intent.priority) {
      return false
    }
    if (intent.estimate !== undefined && (issue.estimate ?? null) !== intent.estimate) {
      return false
    }
    if (intent.dueDate !== undefined && (issue.dueDate ?? null) !== intent.dueDate) {
      return false
    }
    if (intent.projectId !== undefined && (issue.project?.id ?? null) !== intent.projectId) {
      return false
    }
    const issueLabelIds = issue.labelIds ?? issue.labels?.map((label) => label.id) ?? []
    if (intent.labelIds !== undefined && !sameStringSet(issueLabelIds, intent.labelIds)) {
      return false
    }
    return true
  }
}
