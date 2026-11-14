import { z } from 'zod'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../../shared/agent-session/agent-session-question-answer'
import type { AgentJournalQuestion } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS } from '../../native-chat/agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import { pendingAcpResolution, type AcpRequestPresentation } from '../acp-dialects/acp-dialect'
import { AcpRpcError } from '../transport/acp-errors'

export const ACP_FORM_ELICITATION_METHOD = 'elicitation/create'
const OTHER_SUFFIXES = ['__other', '_custom'] as const
const NOT_SHOWN_ANSWER = `Not shown to the user: Orca shows at most ${MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS} questions at once. Ask again.`

const choiceSchema = z.looseObject({
  const: z.string(),
  title: z.string().optional(),
  description: z.string().optional()
})
const propertySchema = z.looseObject({
  type: z.enum(['string', 'boolean', 'array', 'number', 'integer']),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
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
  requestedSchema: z.looseObject({
    properties: z.record(z.string(), propertySchema),
    required: z.array(z.string()).optional()
  })
})

type Choice = { value: string; label: string; description?: string }
type Field = { key: string; otherKey?: string; choices?: Choice[]; question: AgentJournalQuestion }

// Strict decimal: rejects hex, Infinity, and whitespace inside the number that Number() would accept.
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

const unsupportedForm = () => new AcpRpcError(-32602, 'Unsupported ACP elicitation form')

/** A field with no choices becomes a text answer; enums and arrays become pickable options. */
function fieldChoices(
  property: z.infer<typeof propertySchema>,
  hasOther: boolean
): Choice[] | undefined {
  if (property.type === 'number' || property.type === 'integer') {
    return undefined
  }
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
  if ((choices?.length === 0 && !hasOther) || (property.type === 'array' && !choices)) {
    throw unsupportedForm()
  }
  return choices
}

/** Whether a schema property expects a numeric answer. */
function isNumeric(property: z.infer<typeof propertySchema>): boolean {
  return property.type === 'number' || property.type === 'integer'
}

/** Describes the accepted number type and bounds so rejected answers can be corrected. */
function numericRules(property: z.infer<typeof propertySchema>): string {
  const bounds = [
    property.minimum !== undefined ? `at least ${property.minimum}` : undefined,
    property.maximum !== undefined ? `at most ${property.maximum}` : undefined
  ].filter(Boolean)
  const kind = property.type === 'integer' ? 'integer' : 'number'
  return [kind, ...bounds].join(' ')
}

/** Keeps form field identity while presenting choices and text on the existing question card. */
export function acpFormElicitationPresentation(params: unknown): AcpRequestPresentation {
  const parsed = formSchema.safeParse(params)
  if (!parsed.success) {
    throw unsupportedForm()
  }
  const { message, requestedSchema } = parsed.data
  const properties = requestedSchema.properties
  const required = new Set(requestedSchema.required)
  const otherKeys = new Map<string, string>()
  for (const [key, property] of Object.entries(properties)) {
    if (
      required.has(key) ||
      (property.type !== 'string' && property.type !== 'array') ||
      !(property.enum || property.oneOf || property.type === 'array')
    ) {
      continue
    }
    const otherKey = OTHER_SUFFIXES.map((suffix) => key + suffix).find((candidate) => {
      const other = properties[candidate]
      return (
        other?.type === 'string' &&
        !other.enum &&
        !other.oneOf &&
        other.format === undefined &&
        !required.has(candidate)
      )
    })
    if (otherKey) {
      otherKeys.set(key, otherKey)
    }
  }
  const companions = new Set(otherKeys.values())
  const keys = Object.keys(properties).filter((key) => !companions.has(key))
  if (keys.length === 0) {
    throw unsupportedForm()
  }
  const fields: Field[] = keys.slice(0, MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS).map((key, index) => {
    const property = properties[key]!
    const otherKey = otherKeys.get(key)
    const choices = fieldChoices(property, otherKey !== undefined)
    const id = `q${index + 1}`
    const question: AgentJournalQuestion = {
      id,
      question: [...new Set([message, property.title, property.description].filter(Boolean))].join(
        '\n\n'
      ),
      ...(property.title ? { header: property.title } : {}),
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
              // Blank is an answer only for text; an optional number is simply left out.
              allowEmpty: !isNumeric(property) || !required.has(key),
              ...(typeof property.default === 'string'
                ? { multiline: true, initialValue: property.default }
                : typeof property.default === 'number'
                  ? { initialValue: String(property.default) }
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
    question: first?.question ?? message,
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
      const content: Record<string, string | number | boolean | string[]> = {}
      for (const { key, otherKey, choices, question } of fields) {
        const answer = answers.find((entry) => entry.questionId === question.id)!
        if (!choices) {
          const text = answer.other ?? ''
          const property = properties[key]!
          if (!isNumeric(property)) {
            content[key] = text
            continue
          }
          // Validation already rejected a blank required answer, so a blank here is an omitted optional.
          if (!text.trim()) {
            continue
          }
          const value = NUMERIC_TEXT.test(text.trim()) ? Number(text) : Number.NaN
          if (
            !Number.isFinite(value) ||
            (property.type === 'integer' && !Number.isInteger(value)) ||
            (property.minimum !== undefined && value < property.minimum) ||
            (property.maximum !== undefined && value > property.maximum)
          ) {
            throw new AcpRpcError(
              -32602,
              `Question answer must be a valid ${numericRules(property)}`
            )
          }
          content[key] = value
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
        const otherKey = otherKeys.get(key)
        if (otherKey) {
          content[otherKey] = NOT_SHOWN_ANSWER
        } else if (
          properties[key]!.type === 'string' &&
          !properties[key]!.enum &&
          !properties[key]!.oneOf
        ) {
          content[key] = NOT_SHOWN_ANSWER
        }
      }
      return { action: 'accept', content }
    }
  }
}
