import {
  randomUUID,
  LINEAR_WRITE_BODY_CAP,
  addLinearIssueCommentForAgent,
  createLinearIssueAttachment,
  LinearWriteFailure,
  linearError
} from './runtime-linear-command-dependencies'
import type {
  LinearCurrentIssueContextHints,
  LinearAttachResult,
  LinearCommentAddResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCreateCommands } from './runtime-linear-create-commands'

export class RuntimeLinearCommentCommands extends RuntimeLinearCreateCommands {
  async linearIssueAddComment(params: {
    input?: string
    current?: boolean
    workspaceId?: string
    body: string
    replyTo?: string
    writeId?: string
    context?: LinearCurrentIssueContextHints
  }): Promise<LinearCommentAddResult> {
    if (params.body.length > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear comment body is too large.')
    }
    const target = await this.resolveLinearAgentWriteTarget(params)
    const parentId = params.replyTo
      ? await this.resolveLinearCommentParentId(target.issue.id, params.replyTo, target.workspaceId)
      : null
    const writeId = params.writeId ?? randomUUID()
    const existing =
      params.writeId !== undefined
        ? await this.getMatchingLinearCommentWrite(
            writeId,
            target.issue.id,
            parentId,
            target.workspaceId,
            true
          )
        : null
    if (existing) {
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearCommentResult(existing, target, params.body.length, writeId, true)
    }

    try {
      const comment = await this.runLinearAgentWrite(
        (signal) =>
          addLinearIssueCommentForAgent(target.issue.id, params.body, target.workspaceId, {
            id: writeId,
            parentId,
            signal
          }),
        (cause) =>
          this.linearCreateStyleUnconfirmed('comment', writeId, target, {
            parentId,
            bodyRequired: true,
            cause
          })
      )
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearCommentResult(comment, target, params.body.length, writeId, false)
    } catch (error) {
      if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
        const comment = await this.refetchLinearCommentAfterDuplicate(
          writeId,
          target.issue.id,
          parentId,
          target.workspaceId,
          () =>
            this.linearCreateStyleUnconfirmed('comment', writeId, target, {
              parentId,
              bodyRequired: true
            })
        )
        await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
        return this.linearCommentResult(comment, target, params.body.length, writeId, true)
      }
      throw error
    }
  }

  async linearIssueAttachLink(params: {
    input?: string
    current?: boolean
    workspaceId?: string
    url: string
    title?: string
    writeId?: string
    context?: LinearCurrentIssueContextHints
  }): Promise<LinearAttachResult> {
    const url = this.parseLinearAttachmentUrl(params.url)
    const target = await this.resolveLinearAgentWriteTarget(params)
    const writeId = params.writeId ?? randomUUID()
    const title = params.title?.trim() || this.defaultLinearAttachmentTitle(url)
    const existing =
      params.writeId !== undefined
        ? await this.getMatchingLinearAttachmentWrite(
            writeId,
            target.issue.id,
            target.workspaceId,
            true
          )
        : null
    if (existing) {
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearAttachResult(existing, target, writeId, true)
    }
    try {
      const attachment = await this.runLinearAgentWrite(
        (signal) =>
          createLinearIssueAttachment(
            target.issue.id,
            { id: writeId, title, url: url.toString() },
            target.workspaceId,
            { signal }
          ),
        (cause) =>
          this.linearCreateStyleUnconfirmed('attach', writeId, target, {
            title,
            url: url.toString(),
            cause
          })
      )
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearAttachResult(attachment, target, writeId, false)
    } catch (error) {
      if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
        const attachment = await this.refetchLinearAttachmentAfterDuplicate(
          writeId,
          target.issue.id,
          target.workspaceId,
          () =>
            this.linearCreateStyleUnconfirmed('attach', writeId, target, {
              title,
              url: url.toString()
            })
        )
        await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
        return this.linearAttachResult(attachment, target, writeId, true)
      }
      throw error
    }
  }
}
