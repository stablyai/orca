import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { escapeTerminalControlCharacters } from '../../../shared/terminal-control-character-escape'
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
          `${value.requestId} [${value.state}]${value.method ? ` ${value.method}` : ''}\n${value.interpretation}${value.receipt === undefined ? '' : `\n${escapeTerminalControlCharacters(JSON.stringify(value.receipt, null, 2))}`}`
      )
      return
    }
    // The stored receipt can echo a whole spec or body back; recovery needs only its ids.
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        requestId: value.requestId,
        state: value.state,
        method: value.method,
        receipt: receiptIds(value.receipt),
        interpretation: value.interpretation
      })
    })
  }
}

const ID_KEY = /^(id|state|action|\w+Id)$/

// Keep every id and outcome (state, lifecycle action) where the receipt nests it (messageId, accepted.dispatchId, run.id), and drop all text.
function receiptIds(value: unknown, depth = 8): unknown {
  if (depth === 0 || typeof value !== 'object' || value === null) {
    return undefined
  }
  if (Array.isArray(value)) {
    const kept = value.map((item) => receiptIds(item, depth - 1)).filter((ids) => ids !== undefined)
    return kept.length ? kept : undefined
  }
  const kept: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const ids =
      typeof child === 'string'
        ? ID_KEY.test(key)
          ? child
          : undefined
        : receiptIds(child, depth - 1)
    if (ids !== undefined) {
      kept[key] = ids
    }
  }
  return Object.keys(kept).length ? kept : undefined
}
