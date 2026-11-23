import { parseClickUpTaskReference } from '../../shared/clickup/clickup-task-reference'
import { taskProviderFailure } from '../../shared/work-items/task-provider-failure'
import type {
  ClickUpCommentResult,
  ClickUpMutationResult,
  ClickUpTaskUpdate
} from '../../shared/clickup/clickup-types'
import { clickupRequest } from './authenticated-request'
import { isClickUpAuthError } from './clickup-api-error'
import { withClickUpContext } from './client'
import { clearScannedClickUpPages } from './clickup-task-scan-cache'
import { taskEndpoint } from './clickup-task-queries'

type MutationFailure = ReturnType<typeof taskProviderFailure>

function notConnected(): MutationFailure {
  return taskProviderFailure('clickup.notConnected', 'Not connected to ClickUp.')
}

function taskIdRequired(): MutationFailure {
  return taskProviderFailure('clickup.taskIdRequired', 'A valid ClickUp task id is required.')
}

export async function addTaskComment(input: string, body: string): Promise<ClickUpCommentResult> {
  const reference = parseClickUpTaskReference(input)
  if (!reference) {
    return taskIdRequired()
  }
  const text = body.trim()
  if (!text) {
    return taskProviderFailure('clickup.commentBodyRequired', 'Comment body is required.')
  }
  try {
    const result = await withClickUpContext(
      async (context) => {
        const endpoint = taskEndpoint(reference, context, '/comment')
        if (!endpoint) {
          return taskIdRequired()
        }
        const created = await clickupRequest<{ id?: unknown }>(context.token, endpoint, {
          method: 'POST',
          body: JSON.stringify({ comment_text: text, notify_all: false }),
          signal: context.signal
        })
        return typeof created?.id === 'string' || typeof created?.id === 'number'
          ? ({ ok: true, id: String(created.id) } as const)
          : taskProviderFailure('clickup.commentFailed', 'ClickUp did not confirm the comment.')
      },
      { write: true }
    )
    return result ?? notConnected()
  } catch (error) {
    if (isClickUpAuthError(error)) {
      throw error
    }
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('clickup.commentFailed', 'Failed to add comment.')
  }
}

export async function updateTask(
  input: string,
  updates: ClickUpTaskUpdate
): Promise<ClickUpMutationResult> {
  const reference = parseClickUpTaskReference(input)
  if (!reference) {
    return taskIdRequired()
  }
  const status = updates.status?.trim()
  if (!status) {
    return taskProviderFailure('clickup.updatesRequired', 'A status is required.')
  }
  try {
    const result = await withClickUpContext(
      async (context) => {
        const endpoint = taskEndpoint(reference, context)
        if (!endpoint) {
          return taskIdRequired()
        }
        await clickupRequest<unknown>(context.token, endpoint, {
          method: 'PUT',
          body: JSON.stringify({ status }),
          signal: context.signal
        })
        clearScannedClickUpPages()
        return { ok: true } as const
      },
      { write: true }
    )
    return result ?? notConnected()
  } catch (error) {
    if (isClickUpAuthError(error)) {
      throw error
    }
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('clickup.updateFailed', 'Failed to update task.')
  }
}
