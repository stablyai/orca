import {
  randomUUID,
  LINEAR_WRITE_BODY_CAP,
  addLinearIssueCommentForAgent,
  createLinearIssueAttachment,
  deleteLinearIssueCommentForAgent,
  getLinearCommentByUuidForAgent,
  isLinearUuid,
  updateLinearIssueCommentForAgent,
  LinearWriteFailure
} from './runtime-linear-command-dependencies'
import { linearError } from '../linear/issue-context/errors'
import type { LinearAgentAccessError } from '../linear/issue-context/errors'
import type {
  LinearCurrentIssueContextHints,
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCommentDeleteResult,
  LinearCommentEditResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCreateCommands } from './runtime-linear-create-commands'
import { getConnectedWorkspaces } from '../linear/issue-context/client'
import { resolveWorkspaceSelector } from '../linear/issue-context/workspaces'
import { runLinearCommentAction } from './runtime-linear-comment-action'

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

  async linearCommentEdit(
    params: {
      commentId: string
      body: string
      workspaceId?: string
    },
    signal?: AbortSignal
  ): Promise<LinearCommentEditResult> {
    if (params.body.length > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear comment body is too large.')
    }
    const {
      owner: { comment, workspaceId },
      result: edited
    } = await runLinearCommentAction(
      (discoverySignal) => this.resolveLinearAgentComment(params, discoverySignal),
      (owner, options) =>
        updateLinearIssueCommentForAgent(owner.comment.id, params.body, owner.workspaceId, options),
      (owner) => this.linearCommentChangeUnconfirmed('edit', owner.comment, owner.workspaceId),
      (error) => this.mapLinearReadFailure(error),
      signal
    )
    await this.notifyLinearLinkedIssueUpdated(workspaceId, comment.issue.identifier)
    return {
      comment: { id: edited.id, url: edited.url, parentId: edited.parentId },
      issue: this.linearWriteIssueRef(comment.issue),
      meta: { workspaceId, bodyChars: params.body.length }
    }
  }

  async linearCommentDelete(
    params: {
      commentId: string
      workspaceId?: string
    },
    signal?: AbortSignal
  ): Promise<LinearCommentDeleteResult> {
    const {
      owner: { comment, workspaceId }
    } = await runLinearCommentAction(
      (discoverySignal) => this.resolveLinearAgentComment(params, discoverySignal),
      (owner, options) =>
        deleteLinearIssueCommentForAgent(owner.comment.id, owner.workspaceId, options),
      (owner) => this.linearCommentChangeUnconfirmed('delete', owner.comment, owner.workspaceId),
      (error) => this.mapLinearReadFailure(error),
      signal
    )
    await this.notifyLinearLinkedIssueUpdated(workspaceId, comment.issue.identifier)
    return {
      comment: { id: comment.id, parentId: comment.parentId },
      issue: this.linearWriteIssueRef(comment.issue),
      meta: { workspaceId }
    }
  }

  // A UUID has one owner; unrelated unavailable workspaces must not delay its mutation.
  public async resolveLinearAgentComment(
    params: {
      commentId: string
      workspaceId?: string
    },
    signal: AbortSignal
  ): Promise<{ comment: LinearAgentComment; workspaceId: string }> {
    if (!isLinearUuid(params.commentId)) {
      throw this.linearCommentNotFound(params.commentId)
    }
    const workspaces = getConnectedWorkspaces()
    if (workspaces.length === 0) {
      throw linearError('linear_not_connected', 'Linear is not connected.')
    }
    const selected = resolveWorkspaceSelector(params, workspaces)
    const missing = this.linearCommentNotFound(params.commentId)
    try {
      return await Promise.any(
        (selected ? [selected] : workspaces).map(async (workspace) => {
          const comment = await getLinearCommentByUuidForAgent(
            params.commentId,
            workspace.id,
            signal
          )
          if (!comment) {
            throw missing
          }
          return { comment, workspaceId: workspace.id }
        })
      )
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        throw error
      }
      const failures: unknown[] = error.errors.filter((reason: unknown) => reason !== missing)
      if (failures.length > 0) {
        throw this.mapLinearReadFailure(failures[0])
      }
      throw missing
    }
  }

  public linearCommentNotFound(commentId: string): LinearAgentAccessError {
    return linearError(
      'linear_comment_not_found',
      `No Linear issue comment ${commentId} was found.`,
      {
        nextSteps: [
          'Run `orca linear issue <id> --comments --json` and pass a comment `id` from it.'
        ]
      }
    )
  }

  public linearCommentChangeUnconfirmed(
    verb: 'edit' | 'delete',
    comment: LinearAgentComment,
    workspaceId: string,
    cause?: string
  ): LinearAgentAccessError {
    const issue = comment.issue.identifier
    const readBack = `orca linear issue ${issue} --comments --workspace ${workspaceId} --json`
    return linearError(
      'linear_write_unconfirmed',
      `Linear may have applied the comment ${verb}, but Orca could not confirm it.`,
      {
        workspaceId,
        issueIdentifier: comment.issue.identifier,
        nextSteps: [
          `Run \`${readBack}\` and rerun the ${verb} only if comment ${comment.id} ${
            verb === 'edit' ? 'still has its old body' : 'is still listed'
          }.`
        ],
        ...(cause ? { cause } : {})
      }
    )
  }
}

type LinearAgentComment = NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>
