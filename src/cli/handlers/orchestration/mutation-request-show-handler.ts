import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { printOrchestrationResult } from './agent-view'
import { getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { OrchestrationMutationRequestShowResult } from '../../../shared/orchestration-mutation-request'

export const ORCHESTRATION_REQUEST_SHOW_HANDLER: Record<string, CommandHandler> = {
  'orchestration request-show': async ({ flags, client, json }) => {
    const request = getRequiredStringFlag(flags, 'request')
    const result = await client
      .call<OrchestrationMutationRequestShowResult>('orchestration.requestShow', { request })
      .catch((error: unknown) => {
        if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
          throw new RuntimeClientError(
            'incompatible_runtime',
            'This Orca server cannot look up orchestration mutation requests yet. Update Orca on the server, or inspect the Dispatch directly with orchestration worker-show.'
          )
        }
        throw error
      })
    if (flags.has('full')) {
      printResult(
        result,
        json,
        (value) =>
          `${value.requestId} [${value.state}]${value.method ? ` ${value.method}` : ''}\n${value.interpretation}`
      )
      return
    }
    // The stored receipt can echo a whole spec or body back; recovery needs only its ids.
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        requestId: value.requestId,
        state: value.state,
        method: value.method,
        ...receiptIds(value.receipt),
        interpretation: value.interpretation
      })
    })
  }
}

function receiptIds(receipt: unknown): {
  dispatchId?: string
  taskId?: string
  messageId?: string
} {
  if (!isRecord(receipt)) {
    return {}
  }
  return {
    dispatchId: stringOrUndefined(receipt.dispatchId),
    taskId:
      stringOrUndefined(receipt.taskId) ??
      (isRecord(receipt.task) ? stringOrUndefined(receipt.task.id) : undefined),
    messageId: isRecord(receipt.message) ? stringOrUndefined(receipt.message.id) : undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
