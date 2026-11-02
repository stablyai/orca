/**
 * What a relay-era terminal prints for a served `orca orchestration` command, and the ack its
 * relay sends back once that output is on screen.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type OrchestrationCheckOutput
} from '../../../shared/orchestration-check-output'
import type { RpcResponse } from '../../runtime/rpc/core'
import { stringFlag } from './legacy-relay-cli-args'
import type { LegacyRelayCliCall, LegacyRelayCliCaller } from './legacy-relay-cli-caller'

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
  postOutput?: PostOutput
}
export type PostOutput =
  | { kind: 'legacy_check_ack'; terminal: string; messageIds: string[]; types?: string[] }
  | { kind: 'legacy_question_ack'; terminal: string; questionId: string; answerMessageId: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function formatError(response: Extract<RpcResponse, { ok: false }>, json: boolean): CliResult {
  return json
    ? { stdout: `${JSON.stringify(response, null, 2)}\n`, stderr: '', exitCode: 1 }
    : { stdout: '', stderr: `${response.error.message}\n`, exitCode: 1 }
}

function exitCodeFor(method: string, result: Record<string, unknown>): number {
  const lifecycle = result.lifecycle
  if (isRecord(lifecycle) && lifecycle.action === 'rejected') {
    return 1
  }
  if (method !== 'orchestration.ask') {
    return 0
  }
  if (isRecord(result.legacyCompatibility) && result.legacyCompatibility.resumeRequired === true) {
    return 75
  }
  return result.timedOut === true || result.cancelled === true ? 1 : 0
}

export function formatLegacyRelayCliResult(
  call: LegacyRelayCliCall,
  response: RpcResponse,
  caller: LegacyRelayCliCaller,
  flags: Map<string, string | boolean>
): CliResult {
  const json = flags.has('json')
  if (!response.ok) {
    return formatError(response, json)
  }
  const result = isRecord(response.result) ? response.result : {}
  const exitCode = exitCodeFor(call.method, result)
  const postOutput = legacyPostOutput(call, result, caller, flags)
  const finish = (stdout: string, stderr = ''): CliResult => ({
    stdout,
    stderr,
    exitCode,
    ...(postOutput ? { postOutput } : {})
  })
  if (call.method === 'orchestration.check') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orchestration.check's handler returns this output shape on success.
    const check = response.result as OrchestrationCheckOutput
    const prepared = prepareOrchestrationCheckOutput(check, caller.handle, flags.has('format'))
    return json
      ? finish(`${JSON.stringify({ ...response, result: prepared }, null, 2)}\n`)
      : finish(`${formatOrchestrationCheckText(prepared, caller.handle)}\n`)
  }
  if (json) {
    return finish(`${JSON.stringify(response, null, 2)}\n`)
  }
  if (call.method === 'orchestration.ask') {
    return finish(...formatAsk(result))
  }
  return finish(`${JSON.stringify(result)}\n`)
}

function formatAsk(result: Record<string, unknown>): [string, string] {
  const question = String(result.messageId ?? 'unknown')
  const compatibility = isRecord(result.legacyCompatibility) ? result.legacyCompatibility : {}
  if (compatibility.resumeRequired === true && typeof compatibility.resumeCommand === 'string') {
    return [`Question ${question} committed.\nResume with: ${compatibility.resumeCommand}\n`, '']
  }
  const answer = typeof result.answer === 'string' && result.answer ? `${result.answer}\n` : ''
  if (result.timedOut === true) {
    return [
      answer,
      `ask timeout after ${String(result.timeoutMs ?? 0)}ms; question ${question} is still pending. Resume waiting with --resume ${question}; do not ask again.\n`
    ]
  }
  return result.cancelled === true
    ? [answer, `ask cancelled (question ${question})\n`]
    : [answer, '']
}

/** The old relay sends this back once the output above is on the terminal (legacy-contract acks). */
function legacyPostOutput(
  call: LegacyRelayCliCall,
  result: Record<string, unknown>,
  caller: LegacyRelayCliCaller,
  flags: Map<string, string | boolean>
): PostOutput | undefined {
  const compatibility = isRecord(result.legacyCompatibility) ? result.legacyCompatibility : null
  if (!compatibility) {
    return undefined
  }
  const ids = compatibility.ackMessageIds
  if (
    call.method === 'orchestration.check' &&
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id): id is string => typeof id === 'string')
  ) {
    const types = stringFlag(flags, 'types')
      ?.split(',')
      .map((type) => type.trim())
      .filter(Boolean)
    return {
      kind: 'legacy_check_ack',
      terminal: caller.handle,
      messageIds: ids,
      ...(types ? { types } : {})
    }
  }
  const ack = compatibility.answerAcknowledgement
  if (
    call.method === 'orchestration.ask' &&
    typeof result.answer === 'string' &&
    isRecord(ack) &&
    typeof ack.questionId === 'string' &&
    typeof ack.answerMessageId === 'string'
  ) {
    return {
      kind: 'legacy_question_ack',
      terminal: caller.handle,
      questionId: ack.questionId,
      answerMessageId: ack.answerMessageId
    }
  }
  return undefined
}
