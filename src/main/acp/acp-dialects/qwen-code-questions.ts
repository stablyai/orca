import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { AcpRpcError } from '../transport/acp-errors'
import { pendingAcpResolution, type AcpRequestPresentation } from './acp-dialect'

// ask_user_question arrives as a permission request whose Submit reply carries `answers`.
const questionRequestSchema = lazyZodSchema(() =>
  z.looseObject({
    toolCall: z.looseObject({
      _meta: z.looseObject({
        qwenInteractionKind: z.literal('user_question'),
        qwenQuestions: z
          .array(
            z.looseObject({
              question: z.string(),
              header: z.string().nullish(),
              multiSelect: z.boolean().nullish(),
              options: z.array(
                z.looseObject({ label: z.string(), description: z.string().nullish() })
              )
            })
          )
          .min(1)
      })
    })
  })
)

/** Qwen takes each answer as text keyed by the question's index, so typed answers go through too. */
export function qwenCodeQuestionRequest(
  method: string,
  params: unknown
): AcpRequestPresentation | undefined {
  const parsed =
    method === 'session/request_permission' ? questionRequestSchema.safeParse(params).data : null
  if (!parsed) {
    return undefined
  }
  const questions = parsed.toolCall._meta.qwenQuestions.map((question, index) => ({
    id: String(index),
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    multiSelect: question.multiSelect ?? false,
    options: question.options.map((option, optionIndex) => ({
      id: `o${optionIndex + 1}`,
      label: option.label,
      ...(option.description ? { description: option.description } : {})
    })),
    freeTextQuestionId: String(index)
  }))
  const body = {
    kind: 'question' as const,
    question: questions[0]!.question,
    options: questions[0]!.options,
    questions,
    resolution: pendingAcpResolution
  }
  return {
    body,
    reply: (response) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const answers =
        response.kind === 'answers'
          ? response.answers
          : legacyAgentSessionQuestionAnswers(body, response.optionId)
      if (!answers || !isValidAgentSessionQuestionAnswers(questions, answers)) {
        throw new AcpRpcError(-32602, 'Question answer must answer every offered question')
      }
      return {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: Object.fromEntries(
          answers.map((answer) => {
            const question = questions.find((entry) => entry.id === answer.questionId)!
            const labels = answer.optionIds.map(
              (id) => question.options.find((option) => option.id === id)!.label
            )
            const typed = answer.other?.trim()
            return [answer.questionId, [...labels, ...(typed ? [typed] : [])].join(', ')]
          })
        )
      }
    }
  }
}
