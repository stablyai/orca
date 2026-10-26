import { nativeAnswerParams, type AgentRequestAnswerFile } from './agent-request-answer-file'
import { z } from 'zod'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'
import type { RuntimeRpcSuccess } from './runtime-client'
import {
  listAgentRequests,
  readRequestHost,
  requireSameRuntime,
  sameRequestMarker,
  verifyRequestWorkspace,
  type AgentRequestClient,
  type AgentRequestScope
} from './agent-request-inventory'
import { structuredAgentSessionPayloadFingerprint } from '../shared/structured-agent-session-mutation'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers
} from '../shared/agent-session-question-answer'
import type {
  AgentSessionMutationResult,
  AgentSessionPromptResult
} from '../shared/agent-session-wire'
import { AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY } from '../shared/host-runtime-capabilities'
import { isAgentJournalResolution } from '../shared/agent-session-journal-schemas'
import type { AgentJournalResolution } from '../shared/agent-session-journal-types'
import type { RuntimeStatus } from '../shared/runtime-types'
import { worktreeIdsEqual } from '../shared/worktree/id'

const AcceptedAnswer = z.object({
  ok: z.literal(true),
  replayed: z.boolean(),
  fence: z.number().int().positive(),
  cursor: z.object({ epoch: z.string().min(1), sequence: z.number().int().nonnegative() }),
  value: z.object({
    itemId: z.string().min(1),
    revision: z.number().int().positive(),
    resolution: z.custom<AgentJournalResolution>(isAgentJournalResolution)
  })
})
const RefusedAnswer = z.object({
  ok: z.literal(false),
  refusal: z.object({ code: z.string().min(1), details: z.unknown().optional() })
})
/**
 * Submits a pinned answer; retry resubmits the same operation and may execute it for the first time.
 * A matching receipt proves acceptance, not provider resumption.
 */
export async function answerAgentRequest(
  client: AgentRequestClient,
  scope: AgentRequestScope,
  input: AgentRequestAnswerFile,
  retryOperationId?: string
): Promise<
  RuntimeRpcSuccess<{
    runtimeId: string
    workspaceId: string
    sessionId: string
    clientOperationId: string
    outcome: 'accepted'
    resumed: 'unverified'
    result: Extract<AgentSessionMutationResult<AgentSessionPromptResult>, { ok: true }>
  }>
> {
  if (
    input.sessionId !== scope.sessionId ||
    (scope.turnItemId !== undefined && input.turnItemId !== scope.turnItemId) ||
    (retryOperationId !== undefined && retryOperationId !== input.clientOperationId)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'CLI scope and answer-file identity/retry operation must match exactly.'
    )
  }
  const constrainedScope = {
    ...scope,
    ...(input.turnItemId ? { turnItemId: input.turnItemId } : {})
  }
  const runtimeId = await readRequestHost(client)
  if (runtimeId !== input.expectedRuntimeId) {
    throw new RuntimeClientError(
      'agent_request_unverifiable',
      'The execution runtime differs from the inspected request.'
    )
  }
  const workspaceId = await verifyRequestWorkspace(client, constrainedScope, runtimeId)
  if (!worktreeIdsEqual(workspaceId, input.workspaceId)) {
    throw new RuntimeClientError(
      'agent_request_unverifiable',
      'The answer file belongs to a different workspace.'
    )
  }
  const params = nativeAnswerParams(input)
  if (input.kind === 'question' && input.answers !== undefined) {
    const status = await client.call<RuntimeStatus>('status.get')
    requireSameRuntime(status, runtimeId)
    if (!status.result.capabilities?.includes(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This host cannot accept structured question answers. Update the execution host.'
      )
    }
  }
  if (retryOperationId === undefined) {
    const inventory = await listAgentRequests(client, constrainedScope, runtimeId)
    const prompt = inventory.requests.find((request) => request.itemId === input.itemId)
    if (
      !worktreeIdsEqual(inventory.workspaceId, input.workspaceId) ||
      inventory.fence !== input.expectedRuntimeFence ||
      !sameRequestMarker(inventory.marker, input.expectedRequests) ||
      !prompt ||
      prompt.revision !== input.expectedRevision ||
      prompt.body.kind !== input.kind
    ) {
      throw new RuntimeClientError(
        'agent_request_unverifiable',
        'The inspected request changed. Read it again before answering.'
      )
    }
    if (prompt.body.kind === 'approval') {
      if (!prompt.body.options.some((option) => option.id === input.optionId)) {
        throw new RuntimeClientError(
          'invalid_argument',
          'The selected approval option was not offered.'
        )
      }
    } else if (
      'answers' in params &&
      params.answers !== undefined &&
      !isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(prompt.body), params.answers)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        'The answers do not match the exact questions/options.'
      )
    }
  }
  const pinStatus = await client.call<RuntimeStatus>('status.get')
  requireSameRuntime(pinStatus, runtimeId)
  const sourceId = pinStatus.result.hostDescriptor?.installationId
  if (
    !sourceId ||
    !pinStatus.result.capabilities?.includes(RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This host cannot atomically fence native answers to the inspected runtime. Nothing was sent.'
    )
  }
  const recovery = {
    clientOperationId: input.clientOperationId,
    expectedRuntimeId: runtimeId,
    sessionId: input.sessionId,
    workspaceId,
    resumed: 'unverified' as const
  }
  let response: RuntimeRpcSuccess<unknown>
  try {
    response = await client.call<unknown>(
      input.kind === 'approval'
        ? 'agentSession.respondToApproval'
        : 'agentSession.respondToQuestion',
      params,
      { expectedRuntimeSource: { sourceId, runtimeId } }
    )
    requireSameRuntime(response, runtimeId)
  } catch (error) {
    if (
      (error instanceof RuntimeRpcFailureError && error.code !== 'internal_error') ||
      (error instanceof RuntimeClientError &&
        ['runtime_source_mismatch', 'runtime_source_unverifiable', 'incompatible_runtime'].includes(
          error.code
        ))
    ) {
      throw new RuntimeClientError(error.code, 'The execution host refused the native answer.', {
        ...recovery,
        outcome: error.code === 'agent_session_operation_unknown' ? 'unknown' : 'refused'
      })
    }
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'Native answer outcome is unknown. Do not create a new operation or automatically resend it.',
      {
        ...recovery,
        outcome: 'unknown'
      }
    )
  }
  const refused = RefusedAnswer.safeParse(response.result)
  if (refused.success) {
    throw new RuntimeClientError(
      refused.data.refusal.code,
      'The native answer was refused. No provider resumption is confirmed.',
      {
        ...recovery,
        refusal: refused.data.refusal,
        outcome:
          refused.data.refusal.code === 'agent_session_operation_unknown' ? 'unknown' : 'refused'
      }
    )
  }
  const accepted = AcceptedAnswer.safeParse(response.result)
  if (!accepted.success) {
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'The native answer response is invalid; acceptance is unknown.',
      { ...recovery, outcome: 'unknown' }
    )
  }
  const resolution = accepted.data.value.resolution
  const sameChoice =
    resolution.state === 'resolved' &&
    ('answers' in params && params.answers !== undefined
      ? structuredAgentSessionPayloadFingerprint({
          method: 'answer-value',
          sessionId: input.sessionId,
          fields: { answers: params.answers }
        }) ===
        structuredAgentSessionPayloadFingerprint({
          method: 'answer-value',
          sessionId: input.sessionId,
          fields: { answers: resolution.answers }
        })
      : resolution.selectedOptionId === input.optionId)
  if (
    accepted.data.value.itemId !== input.itemId ||
    accepted.data.value.revision < input.expectedRevision ||
    !sameChoice
  ) {
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'The native answer receipt does not match this exact response.',
      { ...recovery, outcome: 'unknown' }
    )
  }
  return {
    ...response,
    result: {
      runtimeId,
      workspaceId,
      sessionId: input.sessionId,
      clientOperationId: input.clientOperationId,
      outcome: 'accepted',
      resumed: 'unverified',
      result: accepted.data
    }
  }
}
