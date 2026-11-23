import type {
  ClickUpCommentResult,
  ClickUpMutationResult,
  ClickUpStatusOption,
  ClickUpTask
} from '../../shared/clickup/clickup-types'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { readCommandBody } from '../arguments/command-body-input'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveClickUpStatusName } from './clickup-status-match'
import { requireClickUpConnection, requireClickUpTaskInput } from './clickup-target'

const UNVERIFIED_CODES = [
  'runtime_timeout',
  'runtime_connection_failed',
  'runtime_disconnected',
  'runtime_unavailable'
]

async function callClickUpWrite<T>(
  context: HandlerContext,
  method: string,
  params: unknown
): Promise<RuntimeRpcSuccess<T>> {
  try {
    return await context.client.call<T>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && UNVERIFIED_CODES.includes(error.code)) {
      throw new RuntimeClientError(
        'clickup_write_unverified',
        `${error.message} The ClickUp change may have been applied. Verify in ClickUp before retrying.`
      )
    }
    throw error
  }
}

function failWrite(error: string): RuntimeClientError {
  return new RuntimeClientError(
    'clickup_write_failed',
    `${error} ClickUp did not confirm the change. Verify in ClickUp before retrying.`
  )
}

async function addComment(context: HandlerContext): Promise<void> {
  const input = requireClickUpTaskInput(context)
  const body = await readCommandBody(context.flags, context.cwd, {
    required: true,
    maximumCharacters: 100_000,
    tooLargeCode: 'clickup_body_too_large',
    label: 'ClickUp comment'
  })
  if (!body.trim()) {
    throw new RuntimeClientError('invalid_argument', 'Comment body cannot be blank.')
  }
  await requireClickUpConnection(context)
  const response = await callClickUpWrite<ClickUpCommentResult>(context, 'clickup.addTaskComment', {
    id: input,
    body
  })
  if (!response.result.ok) {
    throw failWrite(response.result.error)
  }
  printResult(response, context.json, () => `Commented on ${input}`)
}

async function setStatus(context: HandlerContext): Promise<void> {
  const input = requireClickUpTaskInput(context)
  const wanted = getRequiredStringFlag(context.flags, 'to').trim()
  if (!wanted) {
    throw new RuntimeClientError('invalid_argument', '--to cannot be blank.')
  }
  await requireClickUpConnection(context)
  const { result: task } = await context.client.call<ClickUpTask | null>('clickup.getTask', {
    id: input
  })
  if (!task) {
    throw new RuntimeClientError(
      'clickup_task_unavailable',
      'ClickUp did not return the requested task in the selected Workspace.'
    )
  }
  const { result: statuses } = await context.client.call<ClickUpStatusOption[]>(
    'clickup.listStatuses',
    { listId: task.list.id }
  )
  const status = resolveClickUpStatusName(wanted, statuses)
  const response = await callClickUpWrite<ClickUpMutationResult>(context, 'clickup.updateTask', {
    id: task.id,
    updates: { status }
  })
  if (!response.result.ok) {
    throw failWrite(response.result.error)
  }
  printResult(
    { ...response, result: { ...response.result, id: task.id, status } },
    context.json,
    () => `Set ${task.customId ?? task.id} to "${status}"`
  )
}

export const CLICKUP_WRITE_HANDLERS: Record<string, CommandHandler> = {
  'clickup comment add': addComment,
  'clickup status set': setStatus
}
