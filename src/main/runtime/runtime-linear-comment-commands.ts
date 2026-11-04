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
import { linearError, type LinearAgentAccessError } from '../linear/issue-context/errors'
import type {
  LinearCommentAddRequest,
  LinearAttachRequest,
  LinearCommentEditRequest,
  LinearCommentDeleteRequest,
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCommentDeleteResult,
  LinearCommentEditResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCreateCommands } from './runtime-linear-create-commands'
import { getConnectedWorkspaces } from '../linear/issue-context/client'
import { resolveWorkspaceSelector } from '../linear/issue-context/workspaces'

export class RuntimeLinearCommentCommands extends RuntimeLinearCreateCommands {
  async linearIssueAddComment(
    params: LinearCommentAddRequest,
    cancellation?: AbortSignal
  ): Promise<LinearCommentAddResult> {
    if (params.body.length > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear comment body is too large.')
    }
    const writeId = params.writeId ?? randomUUID()
    const {
      owner: { target },
      result
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const parentId = params.replyTo
          ? await this.resolveLinearCommentParentId(
              target.issue.id,
              params.replyTo,
              target.workspaceId,
              signal
            )
          : null
        const existing =
          params.writeId !== undefined
            ? await this.getMatchingLinearCommentWrite(
                writeId,
                target.issue.id,
                parentId,
                target.workspaceId,
                true,
                signal
              )
            : null
        return { target, parentId, existing }
      },
      async ({ target, parentId, existing }, options) => {
        if (existing) {
          return { record: existing, deduplicated: true }
        }

        try {
          const comment = await addLinearIssueCommentForAgent(
            target.issue.id,
            params.body,
            target.workspaceId,
            {
              id: writeId,
              parentId,
              ...options
            }
          )

          return { record: comment, deduplicated: false }
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
                }),
              options.signal
            )

            return { record: comment, deduplicated: true }
          }
          throw error
        }
      },
      ({ target, parentId }, cause) =>
        this.linearCreateStyleUnconfirmed('comment', writeId, target, {
          parentId,
          bodyRequired: true,
          cause
        }),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearCommentResult(
      result.record,
      target,
      params.body.length,
      writeId,
      result.deduplicated
    )
  }

  async linearIssueAttachLink(
    params: LinearAttachRequest,
    cancellation?: AbortSignal
  ): Promise<LinearAttachResult> {
    const url = this.parseLinearAttachmentUrl(params.url)
    const writeId = params.writeId ?? randomUUID()
    const title = params.title?.trim() || this.defaultLinearAttachmentTitle(url)
    const {
      owner: { target },
      result
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const existing =
          params.writeId !== undefined
            ? await this.getMatchingLinearAttachmentWrite(
                writeId,
                target.issue.id,
                target.workspaceId,
                true,
                signal
              )
            : null
        return { target, existing }
      },
      async ({ target, existing }, options) => {
        if (existing) {
          return { record: existing, deduplicated: true }
        }
        try {
          const attachment = await createLinearIssueAttachment(
            target.issue.id,
            { id: writeId, title, url: url.toString() },
            target.workspaceId,
            options
          )

          return { record: attachment, deduplicated: false }
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
                }),
              options.signal
            )

            return { record: attachment, deduplicated: true }
          }
          throw error
        }
      },
      ({ target }, cause) =>
        this.linearCreateStyleUnconfirmed('attach', writeId, target, {
          title,
          url: url.toString(),
          cause
        }),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearAttachResult(result.record, target, writeId, result.deduplicated)
  }

  async linearCommentEdit(
    params: LinearCommentEditRequest,
    signal?: AbortSignal
  ): Promise<LinearCommentEditResult> {
    if (params.body.length > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear comment body is too large.')
    }
    const {
      owner: { comment, workspaceId },
      result: edited
    } = await this.runLinearAgentAction(
      (discoverySignal) => this.resolveLinearAgentComment(params, discoverySignal),
      (owner, options) =>
        updateLinearIssueCommentForAgent(owner.comment.id, params.body, owner.workspaceId, options),
      (owner) => this.linearCommentChangeUnconfirmed('edit', owner.comment, owner.workspaceId),
      signal,
      (error) => this.mapLinearCommentWriteFailure(error)
    )
    void this.notifyLinearLinkedIssueUpdated(workspaceId, comment.issue.identifier)
    return {
      comment: { id: edited.id, url: edited.url, parentId: edited.parentId },
      issue: this.linearWriteIssueRef(comment.issue),
      meta: { workspaceId, bodyChars: params.body.length }
    }
  }

  async linearCommentDelete(
    params: LinearCommentDeleteRequest,
    signal?: AbortSignal
  ): Promise<LinearCommentDeleteResult> {
    const {
      owner: { comment, workspaceId }
    } = await this.runLinearAgentAction(
      (discoverySignal) => this.resolveLinearAgentComment(params, discoverySignal),
      (owner, options) =>
        deleteLinearIssueCommentForAgent(owner.comment.id, owner.workspaceId, options),
      (owner) => this.linearCommentChangeUnconfirmed('delete', owner.comment, owner.workspaceId),
      signal,
      (error) => this.mapLinearCommentWriteFailure(error)
    )
    void this.notifyLinearLinkedIssueUpdated(workspaceId, comment.issue.identifier)
    return {
      comment: { id: comment.id, parentId: comment.parentId },
      issue: this.linearWriteIssueRef(comment.issue),
      meta: { workspaceId }
    }
  }

  // A UUID has one owner; unrelated unavailable workspaces must not delay its mutation.
  public async resolveLinearAgentComment(
    params: LinearCommentDeleteRequest,
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
