import { clampOrchestrationAskTimeoutMs } from '../../../shared/orchestration-ask-timeout'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../orchestration/db'
import type { LegacyCompatibilityAuthority } from './orchestration-legacy-authority'
import {
  normalizeLegacyText,
  operationIdentity,
  parseLegacyOptions,
  type LegacyAskParams
} from './orchestration-legacy-operation'

export async function handleLegacyAsk(args: {
  runtime: OrcaRuntimeService
  authority: LegacyCompatibilityAuthority
  request: RpcRequest
  params: LegacyAskParams
  signal?: AbortSignal
}): Promise<unknown | undefined> {
  const { runtime, authority, request, params, signal } = args
  const dispatch = authority.resolveAskDispatch(request, params)
  if (!dispatch || dispatch.contract_version !== LEGACY_CONTRACT_VERSION) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  if (!params.resume) {
    if (!params.to) {
      throw new OrchestrationError('invalid_argument', 'Legacy ask requires --to.')
    }
    if (!db.isLegacyCoordinatorHandle(dispatch.run_id, params.to)) {
      throw new OrchestrationError(
        'request_mismatch',
        `Terminal ${params.to} is not a retained coordinator for this legacy Dispatch.`
      )
    }
  }
  const principal = authority.attestWorker(request, dispatch)
  const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
  let questionId = params.resume
  let duplicate = true
  if (questionId) {
    const question = db.getQuestion(questionId)
    if (!question || question.dispatch_id !== dispatch.id) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${questionId} does not belong to this legacy Dispatch.`
      )
    }
  } else {
    const question = params.question as string
    const options = parseLegacyOptions(params.options)
    const recipient = params.to as string
    const operation = operationIdentity(request, 'ask', {
      question: normalizeLegacyText(question),
      options: options.map(normalizeLegacyText),
      recipient
    })
    const priorReceipt = db.getLegacyOperationReceipt(principal.id, operation.key)
    let existingQuestionId: string | undefined
    if (!priorReceipt) {
      const matches = db.findLegacyQuestionsBySemanticIdentity({
        principalId: principal.id,
        question,
        options,
        recipientHandle: recipient
      })
      const unclaimed = matches.filter((match) => !match.claimedByOperation)
      const pending = unclaimed.filter((match) => match.question.status === 'pending')
      const lostAnswer = unclaimed.find(
        (match) => match.question.status === 'answered' && !match.answerAcknowledged
      )
      if (lostAnswer) {
        const cliCommand =
          params.compatibilityCliCommand ?? params.compatibilityWindowsCommand ?? 'orca'
        throw new OrchestrationError(
          'operation_unknown',
          `A matching legacy answer may have been accepted before the update. Run ${cliCommand} orchestration check --terminal ${principal.terminal_handle} before asking again.`
        )
      }
      if (pending.length > 1) {
        throw new OrchestrationError(
          'operation_unknown',
          'Multiple matching pending legacy questions exist; drain legacy check before retrying.'
        )
      }
      existingQuestionId = pending[0]?.question.message_id
    }
    const committed = db.commitLegacyAskOperation({
      question,
      principalId: principal.id,
      operationKey: operation.key,
      method: request.method,
      payloadHash: operation.payloadHash,
      options,
      recipientHandle: recipient,
      existingQuestionId
    })
    questionId = committed.question.message_id
    duplicate = committed.duplicate || Boolean(existingQuestionId)
    if (!duplicate) {
      runtime.notifyMessageArrived(committed.message.to_handle, committed.message.type)
    }
  }

  if (params.compatibilityWindowsCommand && !params.resume) {
    return {
      answer: null,
      messageId: questionId,
      threadId: questionId,
      timedOut: false,
      cancelled: false,
      connectionLost: false,
      timeoutMs,
      legacyCompatibility: {
        resumeRequired: true,
        resumeCommand: `${params.compatibilityWindowsCommand} orchestration ask --resume ${questionId}`
      }
    }
  }

  const deadline = Date.now() + timeoutMs
  while (true) {
    const current = db.getQuestion(questionId as string)
    if (!current || current.status === 'closed') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${questionId as string} closed because its Dispatch is inactive.`
      )
    }
    if (current.status === 'answered') {
      return {
        answer: current.answer_body,
        answerMessageId: current.answer_message_id,
        messageId: current.message_id,
        threadId: current.message_id,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs,
        legacyCompatibility: {
          replayed: duplicate,
          answerAcknowledgement: current.answer_message_id
            ? {
                questionId: current.message_id,
                answerMessageId: current.answer_message_id
              }
            : undefined
        }
      }
    }
    if (signal?.aborted || Date.now() >= deadline) {
      return {
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: !signal?.aborted,
        cancelled: signal?.aborted === true,
        connectionLost: signal?.aborted === true,
        timeoutMs,
        legacyCompatibility: { replayed: duplicate, ackMessageIds: [] }
      }
    }
    await runtime.waitForMessage(principal.terminal_handle, {
      timeoutMs: Math.min(1_000, Math.max(deadline - Date.now(), 1)),
      signal
    })
  }
}
