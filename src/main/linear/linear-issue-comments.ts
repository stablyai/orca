import type { LinearClient } from '@linear/sdk'
import type { LinearComment } from '../../shared/linear/issue-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import {
  ATTACHMENT_BY_UUID_QUERY,
  COMMENT_BY_UUID_QUERY,
  ISSUE_COMMENTS_QUERY,
  type LinearAttachmentByUuidResponse,
  type LinearCommentByUuidResponse,
  type LinearIssueCommentsResponse,
  type LinearRawVariables
} from './linear-issue-query-documents'
import {
  LinearWriteFailure,
  confirmLinearWrite,
  mapRawAttachmentWriteRecord,
  mapRawCommentWriteRecord,
  runLinearWrite,
  type LinearAttachmentWriteRecord,
  type LinearCommentWriteRecord
} from './linear-issue-write-support'

export async function addIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string | null,
  options?: { id?: string; parentId?: string | null }
): Promise<
  | { ok: true; id: string; url?: string | null; parentId?: string | null }
  | { ok: false; error: string }
> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createComment({
      ...(options?.id ? { id: options.id } : {}),
      issueId,
      body,
      ...(options?.parentId ? { parentId: options.parentId } : {})
    })
    if (!result.success) {
      return { ok: false, error: 'Failed to create comment' }
    }
    const comment = await result.comment
    return {
      ok: true,
      id: comment?.id ?? '',
      url: comment?.url ?? null,
      parentId: options?.parentId ?? null
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function addIssueCommentForAgent(
  issueId: string,
  body: string,
  workspaceId: string,
  options: { id: string; parentId?: string | null; signal?: AbortSignal }
): Promise<LinearCommentWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createComment({
      id: options.id,
      issueId,
      body,
      ...(options.parentId ? { parentId: options.parentId } : {})
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Failed to create comment')
    }
    const comment = await confirmLinearWrite(
      'Comment was created but could not be retrieved',
      async () => result.comment
    )
    if (!comment?.id) {
      throw new LinearWriteFailure('unconfirmed', 'Comment was created but could not be retrieved')
    }
    const record = await confirmLinearWrite('Comment was created but could not be retrieved', () =>
      readCommentWriteRecord(client, comment.id)
    )
    if (!record) {
      throw new LinearWriteFailure('unconfirmed', 'Comment was created but could not be retrieved')
    }
    return record
  })
}

export async function createIssueAttachment(
  issueId: string,
  input: { id: string; title: string; url: string },
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearAttachmentWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createAttachment({
      id: input.id,
      issueId,
      title: input.title,
      url: input.url
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Failed to create attachment')
    }
    const attachment = await confirmLinearWrite(
      'Attachment was created but could not be retrieved',
      async () => result.attachment
    )
    if (!attachment?.id) {
      throw new LinearWriteFailure(
        'unconfirmed',
        'Attachment was created but could not be retrieved'
      )
    }
    const record = await confirmLinearWrite(
      'Attachment was created but could not be retrieved',
      () => readAttachmentWriteRecord(client, attachment.id)
    )
    if (!record) {
      throw new LinearWriteFailure(
        'unconfirmed',
        'Attachment was created but could not be retrieved'
      )
    }
    return record
  })
}

async function readCommentWriteRecord(
  client: LinearClient,
  id: string
): Promise<LinearCommentWriteRecord | null> {
  const result = await client.client.rawRequest<LinearCommentByUuidResponse, LinearRawVariables>(
    COMMENT_BY_UUID_QUERY,
    { id }
  )
  const comment = result.data?.comment
  return comment ? mapRawCommentWriteRecord(comment) : null
}

async function readAttachmentWriteRecord(
  client: LinearClient,
  id: string
): Promise<LinearAttachmentWriteRecord | null> {
  const result = await client.client.rawRequest<LinearAttachmentByUuidResponse, LinearRawVariables>(
    ATTACHMENT_BY_UUID_QUERY,
    { id }
  )
  const attachment = result.data?.attachment
  return attachment ? mapRawAttachmentWriteRecord(attachment) : null
}

export async function getIssueComments(
  issueId: string,
  workspaceId?: string | null
): Promise<LinearComment[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const result = await entry.client.client.rawRequest<
      LinearIssueCommentsResponse,
      LinearRawVariables
    >(ISSUE_COMMENTS_QUERY, { id: issueId })
    const nodes = result.data?.issue?.comments?.nodes ?? []
    return nodes.map((node) => ({
      id: node.id,
      body: node.body ?? '',
      // Why: rawRequest returns createdAt as an ISO string already; do not
      // re-serialize (the SDK model path used .toISOString() on a parsed Date).
      createdAt: node.createdAt ?? '',
      user: node.user
        ? {
            displayName: node.user.displayName ?? '',
            avatarUrl: node.user.avatarUrl ?? undefined
          }
        : undefined
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}
