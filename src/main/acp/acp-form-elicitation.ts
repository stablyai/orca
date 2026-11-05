import { z } from 'zod'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../shared/agent-session/agent-session-question-answer'
import type { AgentJournalQuestion } from '../../shared/agent-session/journal/agent-session-journal-types'
import { MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { pendingAcpResolution, type AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpRpcError } from './acp-errors'

export const ACP_FORM_ELICITATION_METHOD = 'elicitation/create'
// OMP pairs each choice field `qN` with a free-text `qN__other`.
const OTHER_SUFFIX = '__other'
const NOT_SHOWN_ANSWER = `Not shown to the user: Orca shows at most ${MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS} questions at once. Ask again.`

const choiceSchema = z.looseObject({
  const: z.string(),
  title: z.string().optional(),
  description: z.string().optional()
})
const propertySchema = z.looseObject({
  type: z.enum(['string', 'boolean', 'array']),
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
  oneOf: z.array(choiceSchema).optional(),
  items: z
    .looseObject({ enum: z.array(z.string()).optional(), anyOf: z.array(choiceSchema).optional() })
    .optional()
})
const formSchema = z.object({
  mode: z.literal('form'),
  message: z.string(),
  requestedSchema: z.looseObject({ properties: z.record(z.string(), propertySchema) })
})

type Choice = { value: string; label: string; description?: string }
type Field = { key: string; otherKey?: string; choices?: Choice[]; question: AgentJournalQuestion }

const unsupportedForm = () => new AcpRpcError(-32602, 'Unsupported ACP elicitation form')

// A form field with no choices becomes a text answer; enums and arrays become pickable options.
function fieldChoices(property: z.infer<typeof propertySchema>): Choice[] | undefined {
  if (property.type === 'boolean') {
    return [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' }
    ]
  }
  const oneOf = property.type === 'array' ? property.items?.anyOf : property.oneOf
  const values = property.type === 'array' ? property.items?.enum : property.enum
  const choices =
    oneOf?.map((choice) => ({
      value: choice.const,
      label: choice.title || choice.const,
      ...(choice.description ? { description: choice.description } : {})
    })) ?? values?.map((value) => ({ value, label: value }))
  if (choices?.length === 0 || (property.type === 'array' && !choices)) {
    throw unsupportedForm()
  }
  return choices
}

/** Presents a form elicitation (OMP's `ask` batch, select, confirm, input) as one question card. */
export function acpFormElicitationPresentation(params: unknown): AcpRequestPresentation {
  const parsed = formSchema.safeParse(params)
  if (!parsed.success) {
    throw unsupportedForm()
  }
  const { message, requestedSchema } = parsed.data
  const properties = requestedSchema.properties
  const keys = Object.keys(properties).filter(
    (key) =>
      !(key.endsWith(OTHER_SUFFIX) && Object.hasOwn(properties, key.slice(0, -OTHER_SUFFIX.length)))
  )
  if (keys.length === 0) {
    throw unsupportedForm()
  }
  const fields: Field[] = keys.slice(0, MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS).map((key, index) => {
    const property = properties[key]!
    const otherKey = Object.hasOwn(properties, key + OTHER_SUFFIX) ? key + OTHER_SUFFIX : undefined
    const choices = fieldChoices(property)
    const id = `q${index + 1}`
    const question: AgentJournalQuestion = {
      id,
      question: keys.length === 1 ? message : property.title || message,
      ...(choices && property.description ? { header: property.description } : {}),
      multiSelect: property.type === 'array',
      options: (choices ?? []).map((choice, choiceIndex) => ({
        id: `o${choiceIndex + 1}`,
        label: choice.value === property.default ? `${choice.label} (Recommended)` : choice.label,
        ...(choice.description ? { description: choice.description } : {})
      })),
      ...(!choices || otherKey ? { freeTextQuestionId: id } : {}),
      ...(!choices
        ? {
            freeTextInput: {
              allowEmpty: true,
              ...(typeof property.default === 'string'
                ? { multiline: true, initialValue: property.default }
                : {}),
              ...(property.description ? { placeholder: property.description } : {})
            }
          }
        : {})
    }
    return { key, otherKey, choices, question }
  })
  const questions = fields.map((field) => field.question)
  // Clients without `questions` read the top-level fields, which can carry only one single-choice question.
  const first = questions.length === 1 && !questions[0]!.multiSelect ? questions[0]! : undefined
  const body = {
    kind: 'question' as const,
    question: message,
    options: first?.options ?? [],
    ...(first?.freeTextQuestionId ? { freeTextQuestionId: first.freeTextQuestionId } : {}),
    ...(first?.freeTextInput ? { freeTextInput: first.freeTextInput } : {}),
    questions,
    resolution: pendingAcpResolution
  }
  return {
    body,
    reply: (response) => {
      if (response === null) {
        return { action: 'cancel' }
      }
      const answers =
        response.kind === 'answers'
          ? response.answers
          : legacyAgentSessionQuestionAnswers(body, response.optionId)
      if (!answers || !isValidAgentSessionQuestionAnswers(questions, answers)) {
        throw new AcpRpcError(-32602, 'Question answer must answer every offered question')
      }
      const content: Record<string, string | boolean | string[]> = {}
      for (const { key, otherKey, choices, question } of fields) {
        const answer = answers.find((entry) => entry.questionId === question.id)!
        if (!choices) {
          content[key] = answer.other ?? ''
          continue
        }
        const values = answer.optionIds.map(
          (id) => choices[question.options.findIndex((option) => option.id === id)]!.value
        )
        if (question.multiSelect) {
          content[key] = values
        } else if (values[0] !== undefined) {
          content[key] = properties[key]!.type === 'boolean' ? values[0] === 'true' : values[0]
        }
        if (otherKey && answer.other?.trim()) {
          content[otherKey] = answer.other
        }
      }
      for (const key of keys.slice(MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS)) {
        const otherKey = key.endsWith(OTHER_SUFFIX) ? key : key + OTHER_SUFFIX
        if (Object.hasOwn(properties, otherKey)) {
          content[otherKey] = NOT_SHOWN_ANSWER
        }
      }
      return { action: 'accept', content }
    }
  }
}
