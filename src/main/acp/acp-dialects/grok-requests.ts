import { z } from 'zod'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../../shared/agent-session-question-answer'
import { AcpRpcError } from '../acp-errors'
import { pendingAcpResolution } from '../acp-timeline-requests'
import type { AcpRequestPresentation, AcpRequestSettlement } from './acp-dialect'

const questionRequestSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  questions: z
    .array(
      z.object({
        question: z.string(),
        multiSelect: z.boolean().nullish(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() }))
      })
    )
    .min(1)
})
const planRequestSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  planContent: z.string().nullish()
})

function questionRequest(params: unknown): AcpRequestPresentation {
  const parsed = questionRequestSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Invalid agent question request')
  }
  const questions = parsed.data.questions.map((question, index) => ({
    id: `q${index + 1}`,
    question: question.question,
    multiSelect: question.multiSelect ?? false,
    options: question.options.map((option, optionIndex) => ({
      id: `o${optionIndex + 1}`,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description })
    })),
    freeTextQuestionId: `q${index + 1}`
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
        return { outcome: 'cancelled' }
      }
      const answers =
        response.kind === 'answers'
          ? response.answers
          : legacyAgentSessionQuestionAnswers(body, response.optionId)
      const choices = answers?.map((answer) =>
        answer.optionIds.length > 0
          ? { questionId: answer.questionId, optionIds: answer.optionIds }
          : answer
      )
      if (!answers || !choices || !isValidAgentSessionQuestionAnswers(questions, choices)) {
        throw new AcpRpcError(-32602, 'Question answer must answer every offered question')
      }
      return {
        outcome: 'accepted',
        answers: Object.fromEntries(
          questions.map((question) => {
            const answer = answers.find((entry) => entry.questionId === question.id)!
            const values = answer.optionIds.map(
              (id) => question.options.find((option) => option.id === id)!.label
            )
            if (values.length === 0 && answer.other?.trim()) {
              values.push('Other')
            }
            return [question.question, question.multiSelect ? values : values[0]]
          })
        ),
        ...(answers.some((answer) => answer.other?.trim())
          ? {
              annotations: Object.fromEntries(
                questions.flatMap((question) => {
                  const notes = answers
                    .find((answer) => answer.questionId === question.id)
                    ?.other?.trim()
                  return notes ? [[question.question, { notes }]] : []
                })
              )
            }
          : {})
      }
    }
  }
}

/** What Grok hears once Orca has shown its plan: no approval is given for the person. */
const PLAN_SHOWN_FEEDBACK =
  'Orca showed your plan to the user. Stop here and wait for their feedback or a request to implement it in a later turn.'

/** Grok's plan-mode exit: its plan goes to the chat's plan row and the gate is answered at once
 *  (`abandoned`), so the turn ends instead of waiting on an approval card. */
function settlePlanRequest(params: unknown): AcpRequestSettlement {
  const parsed = planRequestSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Invalid agent plan request')
  }
  return {
    reply: { outcome: 'abandoned', feedback: PLAN_SHOWN_FEEDBACK },
    plan: parsed.data.planContent?.trim() || 'The agent exited plan mode without writing a plan.'
  }
}

export function grokSettleRequest(
  method: string,
  params: unknown
): AcpRequestSettlement | undefined {
  return ['_x.ai/exit_plan_mode', 'x.ai/exit_plan_mode'].includes(method)
    ? settlePlanRequest(params)
    : undefined
}

export function grokRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  if (['_x.ai/ask_user_question', 'x.ai/ask_user_question'].includes(method)) {
    return questionRequest(params)
  }
  return undefined
}
