import type { z } from 'zod'
import type {
  MessageRow,
  QuestionRow,
  RunRow
} from '../../../../orchestration/db/orchestration-records'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import type { ReplyParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import { resolveRunScope } from '../runs/run-scope'
import type { OrchestrationAccessRuleInput } from '../access/orchestration-method-access'
import { helperQuestionAnswerer } from './helper-question-answerer'

/** Who may answer: the helper a question was asked of, the Run's current consumer, or anyone for plain mail. */
export type ReplyAccess =
  | {
      kind: 'helper'
      original: MessageRow
      question: QuestionRow
      answerer: { dispatchId: string; consumerGeneration: number }
    }
  | { kind: 'run'; original: MessageRow; question: QuestionRow; run: RunRow }
  | { kind: 'message'; original: MessageRow }

export function replyAccess({
  params,
  ctx,
  caller
}: OrchestrationAccessRuleInput<z.infer<typeof ReplyParams>>): ReplyAccess {
  const { runtime, legacyCoordinatorRunId } = ctx
  const db = runtime.getOrchestrationDb()
  const original = db.getMessageById(params.id)
  if (!original) {
    throw new Error(`Message not found: ${params.id}`)
  }
  if (
    legacyCoordinatorRunId &&
    (original.run_id !== legacyCoordinatorRunId ||
      (params.run !== undefined && params.run !== legacyCoordinatorRunId))
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Message ${params.id} does not belong to this adopted Run.`,
      { effectsApplied: false }
    )
  }
  if (
    original.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    original.delivery_contract === 'legacy_direct' ||
    original.delivery_contract === 'audit_only'
  ) {
    throw new OrchestrationError(
      'legacy_read_only',
      'Legacy orchestration messages are inspect-only; no reply was applied.',
      { effectsApplied: false }
    )
  }
  const question = db.getQuestion(params.id)
  if (!question) {
    return { kind: 'message', original }
  }
  const answerer =
    params.run === undefined || params.run === question.run_id
      ? helperQuestionAnswerer(runtime, {
          question: original,
          from: caller,
          session: ctx.orchestrationCaller,
          evidence: ctx.orchestrationCompatibilityEvidence
        })
      : undefined
  if (answerer) {
    return { kind: 'helper', original, question, answerer }
  }
  const run = resolveRunScope(runtime, {
    runId: params.run ?? question.run_id,
    callerTerminalHandle: caller,
    requireCurrentConsumer: true,
    legacyCoordinatorRunId,
    callerEvidence: ctx.orchestrationCompatibilityEvidence,
    callerSession: ctx.orchestrationCaller
  })
  return { kind: 'run', original, question, run }
}
