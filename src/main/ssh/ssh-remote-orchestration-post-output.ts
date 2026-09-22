import { randomUUID } from 'node:crypto'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RpcResponse } from '../runtime/rpc/core'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import type {
  RemoteOrcaCliPostOutput,
  RemoteOrcaCliRequest
} from './ssh-remote-cli-host-passthrough'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { optionalRemoteCliString, resolveRemoteCliHandle } from './ssh-remote-cli-args'

export async function acknowledgeRemoteOrcaCliPostOutput(
  runtime: OrcaRuntimeService,
  args: {
    postOutput: RemoteOrcaCliPostOutput
    env: Record<string, string>
    runtimeAuthority?: RemoteOrcaCliRequest['runtimeAuthority']
  }
): Promise<void> {
  const inheritedEvidence = readOrchestrationCompatibilityEvidence(args.env)
  const orchestrationCompatibilityEvidence = args.runtimeAuthority
    ? { ...inheritedEvidence, host: args.runtimeAuthority }
    : inheritedEvidence
  const params =
    args.postOutput.kind === 'legacy_check_ack'
      ? {
          terminal: args.postOutput.terminal,
          compatibilityAck: JSON.stringify({
            messageIds: args.postOutput.messageIds,
            types: args.postOutput.types
          })
        }
      : {
          terminal: args.postOutput.terminal,
          compatibilityQuestionAck: JSON.stringify({
            questionId: args.postOutput.questionId,
            answerMessageId: args.postOutput.answerMessageId
          })
        }
  const response = await new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS }).dispatch({
    id: `remote-cli-post-output-${randomUUID()}`,
    authToken: 'remote-cli',
    method: 'orchestration.check',
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
}

export function parseRemoteOrcaCliPostOutput(value: unknown): RemoteOrcaCliPostOutput {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.terminal !== 'string') {
    throw invalidPostOutput()
  }
  if (
    value.kind === 'legacy_check_ack' &&
    Array.isArray(value.messageIds) &&
    value.messageIds.every((id) => typeof id === 'string') &&
    (value.types === undefined ||
      (Array.isArray(value.types) && value.types.every((type) => typeof type === 'string')))
  ) {
    return {
      kind: value.kind,
      terminal: value.terminal,
      messageIds: value.messageIds,
      ...(value.types === undefined ? {} : { types: value.types })
    }
  }
  if (
    value.kind === 'legacy_question_ack' &&
    typeof value.questionId === 'string' &&
    typeof value.answerMessageId === 'string'
  ) {
    return {
      kind: value.kind,
      terminal: value.terminal,
      questionId: value.questionId,
      answerMessageId: value.answerMessageId
    }
  }
  throw invalidPostOutput()
}

export function getRemoteCliPostOutput(
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  response: RpcResponse
): RemoteOrcaCliPostOutput | undefined {
  if (!response.ok || !isRecord(response.result)) {
    return undefined
  }
  const compatibility = response.result.legacyCompatibility
  if (!isRecord(compatibility)) {
    return undefined
  }
  const command = parsed.commandPath.join(' ')
  if (
    command === 'orchestration check' &&
    Array.isArray(compatibility.ackMessageIds) &&
    compatibility.ackMessageIds.length > 0 &&
    compatibility.ackMessageIds.every((id) => typeof id === 'string')
  ) {
    const types = optionalRemoteCliString(parsed.flags, 'types')
      ?.split(',')
      .map((type) => type.trim())
      .filter(Boolean)
    return {
      kind: 'legacy_check_ack',
      terminal: resolveRemoteCliHandle(parsed.flags, env, 'terminal'),
      messageIds: compatibility.ackMessageIds,
      ...(types ? { types } : {})
    }
  }
  const acknowledgement = compatibility.answerAcknowledgement
  if (
    command === 'orchestration ask' &&
    response.result.answer !== null &&
    isRecord(acknowledgement) &&
    typeof acknowledgement.questionId === 'string' &&
    typeof acknowledgement.answerMessageId === 'string'
  ) {
    return {
      kind: 'legacy_question_ack',
      terminal: resolveRemoteCliHandle(parsed.flags, env, 'from'),
      questionId: acknowledgement.questionId,
      answerMessageId: acknowledgement.answerMessageId
    }
  }
  return undefined
}

function invalidPostOutput(): RemoteCliArgumentError {
  return new RemoteCliArgumentError('invalid_argument', 'Invalid SSH CLI post-output action.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
