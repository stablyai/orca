import { z } from 'zod'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import { AgentSessionPromptAnswerRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const id = z.string().min(1).max(512)
const text = z.string().max(64 * 1024)
const label = z.string().max(512)
const questionsSchema = z.object({
  toolCallId: id,
  title: text.optional(),
  questions: z
    .array(
      z.object({
        id,
        prompt: text,
        options: z.array(z.object({ id, label })).min(1).max(64),
        allowMultiple: z.boolean().optional()
      })
    )
    .min(1)
    .max(4)
})
const permissionSchema = z.object({
  sessionId: id,
  toolCall: z.object({ toolCallId: id, title: text.optional() }).passthrough(),
  options: z
    .array(
      z.object({
        optionId: id,
        name: label,
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
      })
    )
    .min(1)
    .max(16)
})
const planSchema = z.object({
  toolCallId: id,
  name: text.optional(),
  overview: text.optional(),
  plan: text
})
const pending = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export type Presentation = {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
  cancel?: () => void
  reply: (response: AgentSessionPromptResponse) => unknown
}

export function presentRequest(method: string, params: unknown, sessionId: string): Presentation {
  if (method === 'session/request_permission') {
    const request = permissionSchema.parse(params)
    if (request.sessionId !== sessionId) {
      throw new Error('Permission request belongs to another Cursor session')
    }
    return {
      body: {
        kind: 'approval',
        title: request.toolCall.title ?? 'Cursor tool permission',
        detail: null,
        options: request.options.map((option) => ({ id: option.optionId, label: option.name })),
        resolution: { ...pending }
      },
      reply: (response) => {
        if (
          response.kind !== 'option' ||
          !request.options.some((option) => option.optionId === response.optionId)
        ) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor permission requires an offered option'
          )
        }
        return { outcome: { outcome: 'selected', optionId: response.optionId } }
      }
    }
  }
  if (method === 'cursor/create_plan') {
    const request = planSchema.parse(params)
    return {
      body: {
        kind: 'approval',
        title: request.name ?? 'Review Cursor plan',
        detail: request.overview ?? null,
        subject: { kind: 'plan', text: request.plan },
        options: [
          { id: 'accept', label: 'Approve plan' },
          { id: 'reject', label: 'Keep planning' }
        ],
        resolution: { ...pending }
      },
      reply: (response) => {
        if (response.kind !== 'option' || !['accept', 'reject'].includes(response.optionId)) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor plan requires approval or rejection'
          )
        }
        return { outcome: { outcome: response.optionId === 'accept' ? 'accepted' : 'rejected' } }
      }
    }
  }
  const request = questionsSchema.parse(params)
  return {
    body: {
      kind: 'question',
      question: request.title ?? 'Cursor needs your input',
      options: [],
      questions: request.questions.map((question) => ({
        id: question.id,
        question: question.prompt,
        options: question.options.map((option) => ({ id: option.id, label: option.label })),
        multiSelect: question.allowMultiple ?? false
      })),
      resolution: { ...pending }
    },
    reply: (response) => {
      if (response.kind !== 'answers' || response.answers.length !== request.questions.length) {
        throw new AgentSessionPromptAnswerRejectedError(
          'Cursor requires an answer for every question'
        )
      }
      const answers = request.questions.map((question) => {
        const matches = response.answers.filter((answer) => answer.questionId === question.id)
        const answer = matches.length === 1 ? matches[0] : undefined
        if (
          !answer ||
          answer.other ||
          answer.optionIds.length === 0 ||
          (!question.allowMultiple && answer.optionIds.length !== 1) ||
          new Set(answer.optionIds).size !== answer.optionIds.length ||
          answer.optionIds.some(
            (optionId) => !question.options.some((option) => option.id === optionId)
          )
        ) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor question answer does not match its offered choices'
          )
        }
        return { questionId: question.id, selectedOptionIds: answer.optionIds }
      })
      return { outcome: { outcome: 'answered', answers } }
    }
  }
}
