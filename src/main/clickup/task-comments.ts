import type { ClickUpComment, ClickUpCommentResult } from '../../shared/clickup-types'
import { clickUpRequest, requireClickUpClient } from './client'
import {
  asRecord,
  asString,
  normalizeClickUpUser,
  timestampToIso,
  type JsonRecord
} from './task-mapping'

function commentBody(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .map((segment) => {
      const record = asRecord(segment)
      return asString(record?.text) ?? asString(record?.value) ?? ''
    })
    .join('')
}

export async function getClickUpTaskComments(
  taskId: string,
  workspaceId?: string
): Promise<ClickUpComment[]> {
  const client = requireClickUpClient(workspaceId)
  const response = await clickUpRequest<{ comments?: unknown[] }>(
    client,
    `/task/${encodeURIComponent(taskId)}/comment`
  )
  return (response.comments ?? []).flatMap((value) => {
    const record = asRecord(value)
    const id = asString(record?.id)
    return record && id
      ? [
          {
            id,
            body: commentBody(record.comment_text ?? record.comment),
            createdAt: timestampToIso(record.date) ?? new Date(0).toISOString(),
            user: normalizeClickUpUser(record.user) ?? undefined
          }
        ]
      : []
  })
}

export async function addClickUpTaskComment(
  taskId: string,
  body: string,
  workspaceId?: string
): Promise<ClickUpCommentResult> {
  try {
    const client = requireClickUpClient(workspaceId)
    const response = await clickUpRequest<JsonRecord>(
      client,
      `/task/${encodeURIComponent(taskId)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ comment_text: body, notify_all: false })
      }
    )
    return { ok: true, id: asString(response.id) ?? '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Comment failed.' }
  }
}
