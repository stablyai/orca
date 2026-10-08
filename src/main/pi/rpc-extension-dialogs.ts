import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import type { ProviderTimelineRequestBody } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { piRpcDialogSchema } from './rpc-protocol'

const pendingResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export type PiRpcDialogPresentation = {
  id: string | number
  body: ProviderTimelineRequestBody
  reply: (response: AgentSessionPromptResponse | null) => Record<string, unknown>
}

/** Terminal decoration is deliberately absent from the chat projection. */
export function piRpcDialogPresentation(value: unknown): PiRpcDialogPresentation | null {
  const parsed = piRpcDialogSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const dialog = parsed.data
  if (dialog.method === 'confirm') {
    return {
      id: dialog.id,
      body: {
        kind: 'approval',
        title: dialog.title,
        detail: dialog.message ?? null,
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' }
        ],
        resolution: pendingResolution
      },
      reply: (response) => {
        if (response === null) {
          return { cancelled: true }
        }
        if (response.kind !== 'option' || !['yes', 'no'].includes(response.optionId)) {
          throw new Error('Confirmation must select an offered option')
        }
        return { confirmed: response.optionId === 'yes' }
      }
    }
  }
  const questionId = String(dialog.id)
  const options =
    dialog.method === 'select'
      ? dialog.options.map((label, index) => ({
          id: `option-${index}`,
          label: label || 'Empty value'
        }))
      : []
  return {
    id: dialog.id,
    body: {
      kind: 'question',
      question: [dialog.title, dialog.message].filter((text) => text !== undefined).join('\n\n'),
      options,
      resolution: pendingResolution,
      ...(dialog.method === 'select'
        ? {}
        : {
            freeTextQuestionId: questionId,
            freeTextInput: {
              allowEmpty: true,
              ...(dialog.method === 'editor'
                ? { multiline: true, initialValue: dialog.prefill ?? '' }
                : {}),
              ...(dialog.placeholder === undefined ? {} : { placeholder: dialog.placeholder })
            }
          })
    },
    reply: (response) => {
      if (response === null) {
        return { cancelled: true }
      }
      if (response.kind !== 'answers' || response.answers.length !== 1) {
        throw new Error('Dialog requires one answer')
      }
      const answer = response.answers[0]
      if (dialog.method === 'select') {
        const selected = options.findIndex((option) => option.id === answer.optionIds[0])
        if (answer.optionIds.length !== 1 || answer.other !== undefined || selected === -1) {
          throw new Error('Selection must choose an offered option')
        }
        return { value: dialog.options[selected] }
      }
      if (
        answer.questionId !== questionId ||
        answer.optionIds.length !== 0 ||
        answer.other === undefined
      ) {
        throw new Error('Dialog requires a text answer')
      }
      return { value: answer.other }
    }
  }
}
