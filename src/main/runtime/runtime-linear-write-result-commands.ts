import type {
  getLinearAttachmentByUuidForAgent,
  getLinearCommentByUuidForAgent,
  getLinearIssueByUuidForAgent,
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearAgentWriteTarget
} from './runtime-linear-command-dependencies'
import { RuntimeLinearRetryCommands } from './runtime-linear-retry-commands'

export class RuntimeLinearWriteResultCommands extends RuntimeLinearRetryCommands {
  public linearWriteIssueRef(issue: { id: string; identifier: string; url: string }): {
    id: string
    identifier: string
    url: string
  } {
    return { id: issue.id, identifier: issue.identifier, url: issue.url }
  }

  public linearCommentResult(
    comment: NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>,
    target: LinearAgentWriteTarget,
    bodyChars: number,
    writeId: string,
    deduplicated: boolean
  ): LinearCommentAddResult {
    return {
      comment: { id: comment.id, url: comment.url, parentId: comment.parentId },
      issue: this.linearWriteIssueRef(target.issue),
      meta: { workspaceId: target.workspaceId, bodyChars, writeId, deduplicated }
    }
  }

  public linearAttachResult(
    attachment: NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>,
    target: LinearAgentWriteTarget,
    writeId: string,
    deduplicated: boolean
  ): LinearAttachResult {
    return {
      attachment: { id: attachment.id, title: attachment.title, url: attachment.url },
      issue: this.linearWriteIssueRef(target.issue),
      meta: { workspaceId: target.workspaceId, writeId, deduplicated }
    }
  }

  public linearCreateResult(
    issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    workspaceId: string,
    writeId: string,
    deduplicated: boolean
  ): LinearCreateResult {
    return {
      issue,
      meta: { workspaceId, writeId, deduplicated }
    }
  }
}
