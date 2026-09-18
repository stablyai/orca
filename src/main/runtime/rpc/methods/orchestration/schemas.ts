import { z } from 'zod'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { OptionalString, OptionalBoolean, requiredString } from '../../schemas'
import type { TaskStatus } from '../../../orchestration/db'
import { isGroupAddress } from '../../../orchestration/groups'
import { MESSAGE_TYPES } from '../../../orchestration/types'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import {
  getLifecycleGroupRecipientError,
  isDispatchMutationMessageType
} from '../../../../../shared/rpc-contract/orchestration-params'
export {
  AskParams,
  CheckParams,
  DispatchParams,
  DispatchShowParams,
  InboxParams,
  ReplyParams,
  ResetParams,
  TaskCreateParams,
  TaskListParams
} from '../../../../../shared/rpc-contract/orchestration-params'
export { getLifecycleGroupRecipientError, isDispatchMutationMessageType }

export const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

export async function routeAllMailboxPages(
  routePage: () => { routedCount: number; hasMore: boolean },
  signal?: AbortSignal
): Promise<void> {
  while (true) {
    if (signal?.aborted) {
      throw new OrchestrationError('request_aborted', 'Mailbox routing was cancelled.')
    }
    const page = routePage()
    if (!page.hasMore) {
      return
    }
    await yieldToEventLoop()
    if (signal?.aborted) {
      throw new OrchestrationError('request_aborted', 'Mailbox routing was cancelled.')
    }
  }
}

const SEND_MESSAGE_TYPE_ERROR = [
  `Invalid --type. Expected one of: ${MESSAGE_TYPES.join(', ')}.`,
  'To answer a worker question, use the same Orca CLI executable with orchestration reply --id <msg_id> --body <text>.'
].join(' ')

export function parseRemoteWorkerPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new OrchestrationError('invalid_argument', 'Message payload must be valid JSON.')
  }
}

export function parseMessageTaskId(payload: string | undefined): string | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? typeof (parsed as { taskId?: unknown }).taskId === 'string'
        ? (parsed as { taskId: string }).taskId
        : undefined
      : undefined
  } catch {
    return undefined
  }
}

export function isWorkerReportOutcome(value: unknown): value is 'succeeded' | 'failed' {
  return value === 'succeeded' || value === 'failed'
}

export const SendParams = z
  .object({
    to: OptionalString,
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    body: OptionalString,
    type: z
      .enum(MESSAGE_TYPES, {
        error: SEND_MESSAGE_TYPE_ERROR
      })
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Why: pane key is the remint-stable identity used to verify worker_done/heartbeat ownership; the from handle stays routing metadata.
    senderPaneKey: OptionalString,
    run: OptionalString,
    waitForLifecycleSettlement: OptionalBoolean,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (!isDispatchMutationMessageType(params.type) || !params.to || !isGroupAddress(params.to)) {
      return
    }
    // Why: dispatch lifecycle messages are authority/liveness signals for one coordinator; fanout would create lifecycle mail in unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })

export const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})
export type { DispatchMutationMessageType } from '../../../../../shared/rpc-contract/orchestration-params'
