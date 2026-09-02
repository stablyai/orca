import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type OrchestrationCheckOutput,
  type OrchestrationMessageSummary
} from '../../shared/orchestration-check-output'
import type { RpcResponse } from '../runtime/rpc/core'
import { formatRemoteCli } from './ssh-remote-cli-format'

export function formatRemoteOrchestrationCheck(
  response: RpcResponse,
  json: boolean,
  terminal: string,
  formattedRequested: boolean
): { stdout: string; stderr: string } {
  if (!response.ok || !isRecord(response.result)) {
    return json
      ? { stdout: `${JSON.stringify(response, null, 2)}\n`, stderr: '' }
      : formatRemoteCli(response)
  }
  const messages = Array.isArray(response.result.messages)
    ? response.result.messages.filter(isMessageSummary)
    : []
  const count = typeof response.result.count === 'number' ? response.result.count : messages.length
  const result = prepareOrchestrationCheckOutput(
    { ...(response.result as OrchestrationCheckOutput), messages, count },
    terminal,
    formattedRequested
  )
  if (json) {
    return {
      stdout: `${JSON.stringify({ ...response, result }, null, 2)}\n`,
      stderr: ''
    }
  }
  return {
    stdout: `${formatOrchestrationCheckText(result, terminal)}\n`,
    stderr: ''
  }
}

function isMessageSummary(value: unknown): value is OrchestrationMessageSummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.from_handle === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
