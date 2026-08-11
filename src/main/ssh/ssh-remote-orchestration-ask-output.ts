import type { RpcResponse } from '../runtime/rpc/core'
import { formatRemoteCli } from './ssh-remote-cli-format'
import { hasRemoteLifecycleRejection } from './ssh-remote-orchestration-send'

export function formatRemoteOrchestrationAsk(
  response: RpcResponse,
  json: boolean
): { stdout: string; stderr: string } {
  if (!response.ok || !isRecord(response.result)) {
    return json
      ? { stdout: `${JSON.stringify(response, null, 2)}\n`, stderr: '' }
      : formatRemoteCli(response)
  }
  if (json) {
    return { stdout: `${JSON.stringify(response.result)}\n`, stderr: '' }
  }
  if (isRecord(response.result.legacyCompatibility)) {
    const compatibility = response.result.legacyCompatibility
    if (compatibility.resumeRequired === true && typeof compatibility.resumeCommand === 'string') {
      return {
        stdout:
          `Question ${String(response.result.messageId ?? 'unknown')} committed.\n` +
          `Resume with: ${compatibility.resumeCommand}\n`,
        stderr: ''
      }
    }
  }
  const answer = typeof response.result.answer === 'string' ? response.result.answer : ''
  const thread = typeof response.result.threadId === 'string' ? response.result.threadId : 'unknown'
  const timeoutMs =
    typeof response.result.timeoutMs === 'number' ? response.result.timeoutMs : undefined
  const stderr = response.result.timedOut
    ? `ask timeout after ${timeoutMs ?? 0}ms (thread ${thread})\n`
    : response.result.cancelled
      ? response.result.connectionLost
        ? `ask connection closed (question ${String(response.result.messageId ?? 'unknown')})\n`
        : `ask cancelled (question ${String(response.result.messageId ?? 'unknown')})\n`
      : ''
  return { stdout: answer ? `${answer}\n` : '', stderr }
}

export function getRemoteCliExitCode(command: string, response: RpcResponse): number {
  if (!response.ok || hasRemoteLifecycleRejection(response.result)) {
    return 1
  }
  if (
    command === 'orchestration ask' &&
    isRecord(response.result) &&
    isRecord(response.result.legacyCompatibility) &&
    response.result.legacyCompatibility.resumeRequired === true
  ) {
    return 75
  }
  if (
    command === 'orchestration ask' &&
    isRecord(response.result) &&
    (response.result.timedOut === true || response.result.cancelled === true)
  ) {
    return 1
  }
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
