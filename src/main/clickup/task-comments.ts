import { CLICKUP_CUSTOM_TASK_ID_PATTERN } from '../../shared/clickup-task-url'
import type { ClickUpComment, ClickUpCommentResult } from '../../shared/clickup-types'
import { clickUpRequest, requireClickUpClient } from './client'
import { getClickUpTaskInWorkspace } from './task-lookup'
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

async function resolveCommentTaskId(
  taskId: string,
  workspaceId?: string
): Promise<{ taskId: string; workspaceId?: string }> {
  if (!CLICKUP_CUSTOM_TASK_ID_PATTERN.test(taskId)) {
    return { taskId, workspaceId }
  }
  const client = requireClickUpClient(workspaceId)
  const task = await getClickUpTaskInWorkspace(client, taskId, { tolerateMisses: false })
  if (!task) {
    throw new Error('ClickUp task not found.')
  }
  return { taskId: task.id, workspaceId: workspaceId ?? task.workspaceId }
}

export async function getClickUpTaskComments(
  taskId: string,
  workspaceId?: string
): Promise<ClickUpComment[]> {
  const resolved = await resolveCommentTaskId(taskId, workspaceId)
  const client = requireClickUpClient(resolved.workspaceId)
  const response = await clickUpRequest<{ comments?: unknown[] }>(
    client,
    `/task/${encodeURIComponent(resolved.taskId)}/comment`
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
    const resolved = await resolveCommentTaskId(taskId, workspaceId)
    const client = requireClickUpClient(resolved.workspaceId)
    const response = await clickUpRequest<JsonRecord>(
      client,
      `/task/${encodeURIComponent(resolved.taskId)}/comment`,
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
