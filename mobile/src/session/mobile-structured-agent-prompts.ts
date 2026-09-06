import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'

export type StructuredApprovalItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' }>
}

export type StructuredQuestionItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'question' }>
}

export type StructuredPromptResponseTarget = {
  itemId: string
  expectedRevision: number
  optionId: string
}

type PromptTokenPayload =
  | {
      kind: 'approval'
      itemId: string
      revision: number
      optionId: string
    }
  | {
      kind: 'question-option'
      itemId: string
      revision: number
      optionId: string
    }
  | {
      kind: 'question-free-text'
      itemId: string
      revision: number
      questionId: string
    }

const STRUCTURED_PROMPT_TOKEN_PREFIX = 'structured-agent-prompt:'

export function pendingStructuredApproval(
  item: AgentJournalRenderItem
): item is StructuredApprovalItem {
  return item.body.kind === 'approval' && item.body.resolution.state === 'pending'
}

export function pendingStructuredQuestion(
  item: AgentJournalRenderItem
): item is StructuredQuestionItem {
  return item.body.kind === 'question' && item.body.resolution.state === 'pending'
}

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

function encodePromptToken(payload: PromptTokenPayload): string {
  return `${STRUCTURED_PROMPT_TOKEN_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`
}

function decodePromptToken(value: string): PromptTokenPayload | null {
  if (!value.startsWith(STRUCTURED_PROMPT_TOKEN_PREFIX)) {
    return null
  }
  try {
    const decoded = JSON.parse(
      decodeURIComponent(value.slice(STRUCTURED_PROMPT_TOKEN_PREFIX.length))
    ) as Record<string, unknown>
    if (
      typeof decoded.itemId !== 'string' ||
      typeof decoded.revision !== 'number' ||
      !Number.isFinite(decoded.revision)
    ) {
      return null
    }
    if (decoded.kind === 'approval' && typeof decoded.optionId === 'string') {
      return {
        kind: decoded.kind,
        itemId: decoded.itemId,
        revision: decoded.revision,
        optionId: decoded.optionId
      }
    }
    if (decoded.kind === 'question-option' && typeof decoded.optionId === 'string') {
      return {
        kind: decoded.kind,
        itemId: decoded.itemId,
        revision: decoded.revision,
        optionId: decoded.optionId
      }
    }
    if (decoded.kind === 'question-free-text' && typeof decoded.questionId === 'string') {
      return {
        kind: decoded.kind,
        itemId: decoded.itemId,
        revision: decoded.revision,
        questionId: decoded.questionId
      }
    }
  } catch {
    return null
  }
  return null
}

function decodeQuestionFreeTextAnswer(value: string): {
  payload: Extract<PromptTokenPayload, { kind: 'question-free-text' }>
  answer: string
} | null {
  if (!value.startsWith(STRUCTURED_PROMPT_TOKEN_PREFIX)) {
    return null
  }
  const separator = value.indexOf(':', STRUCTURED_PROMPT_TOKEN_PREFIX.length)
  if (separator === -1) {
    return null
  }
  const payload = decodePromptToken(value.slice(0, separator))
  if (payload?.kind !== 'question-free-text') {
    return null
  }
  return { payload, answer: decodeURIComponent(value.slice(separator + 1)) }
}

export function projectStructuredPermission(
  prompt: StructuredApprovalItem | null
): MobileChatPermission | null {
  if (prompt?.body.kind !== 'approval') {
    return null
  }
  return {
    title: prompt.body.title,
    ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
    options: prompt.body.options.map((option) => ({
      label: option.label,
      send: encodePromptToken({
        kind: 'approval',
        itemId: prompt.itemId,
        revision: prompt.revision,
        optionId: option.id
      })
    }))
  }
}

export function projectStructuredQuestion(
  prompt: StructuredQuestionItem | null
): MobileChatQuestion | null {
  if (prompt?.body.kind !== 'question') {
    return null
  }
  return {
    question: prompt.body.question,
    options: prompt.body.options.map((option) => option.label),
    multiSelect: false,
    allowOther: Boolean(prompt.body.freeTextQuestionId),
    optionTokens: prompt.body.options.map((option) =>
      encodePromptToken({
        kind: 'question-option',
        itemId: prompt.itemId,
        revision: prompt.revision,
        optionId: option.id
      })
    ),
    ...(prompt.body.freeTextQuestionId
      ? {
          freeTextToken: encodePromptToken({
            kind: 'question-free-text',
            itemId: prompt.itemId,
            revision: prompt.revision,
            questionId: prompt.body.freeTextQuestionId
          })
        }
      : {})
  }
}

export function structuredApprovalResponseTarget(
  response: string,
  currentPrompt: StructuredApprovalItem | null
): StructuredPromptResponseTarget | null {
  const token = decodePromptToken(response)
  if (token?.kind === 'approval') {
    return {
      itemId: token.itemId,
      expectedRevision: token.revision,
      optionId: token.optionId
    }
  }
  if (token) {
    return null
  }
  const option = currentPrompt?.body.options.find(
    (candidate) => candidate.id === response || candidate.label === response
  )
  return currentPrompt && option
    ? {
        itemId: currentPrompt.itemId,
        expectedRevision: currentPrompt.revision,
        optionId: option.id
      }
    : null
}

export function structuredQuestionResponseTarget(
  response: string,
  currentPrompt: StructuredQuestionItem | null
): StructuredPromptResponseTarget | null {
  const token = decodePromptToken(response)
  if (token?.kind === 'question-option') {
    return {
      itemId: token.itemId,
      expectedRevision: token.revision,
      optionId: token.optionId
    }
  }
  if (token) {
    return null
  }
  const freeText = decodeQuestionFreeTextAnswer(response)
  if (freeText) {
    const answer = freeText.answer.trim()
    return answer.length > 0
      ? {
          itemId: freeText.payload.itemId,
          expectedRevision: freeText.payload.revision,
          optionId: encodeQuestionAnswer(freeText.payload.questionId, answer)
        }
      : null
  }
  if (!currentPrompt) {
    return null
  }
  const trimmed = response.trim()
  const option = currentPrompt.body.options.find(
    (candidate) => candidate.id === response || candidate.label === trimmed
  )
  if (option) {
    return {
      itemId: currentPrompt.itemId,
      expectedRevision: currentPrompt.revision,
      optionId: option.id
    }
  }
  return currentPrompt.body.freeTextQuestionId && trimmed
    ? {
        itemId: currentPrompt.itemId,
        expectedRevision: currentPrompt.revision,
        optionId: encodeQuestionAnswer(currentPrompt.body.freeTextQuestionId, trimmed)
      }
    : null
}
