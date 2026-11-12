import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalPromptOption
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderTimelineRequestBody } from '../../../native-chat/agent-session-timeline/provider-timeline-event'

// How zcode's three interaction requests render as chat cards, and what each answer writes back.
// A withdrawn request denies permissions and declines questions, which is the safe default.

const TOOL_INPUT_HEAD_BYTES = 4 * 1024

export type ZcodeInteractionPresentation = {
  body: ProviderTimelineRequestBody
  reply: (response: unknown) => unknown
  interactive: true
  requestId: string | null
}

export function zcodeInteractionPresentation(
  method: string,
  params: unknown
): ZcodeInteractionPresentation | null {
  const record = readRecord(params)
  if (!record) {
    return null
  }
  const requestId = readString(record.requestId)
  if (method === 'interaction/requestPermission') {
    return permissionPresentation(record, requestId)
  }
  if (method === 'interaction/requestUserInput') {
    const schema = readRecord(record.schema)
    return schema?.interaction === 'plan_approval'
      ? planApprovalPresentation(record, requestId)
      : askUserPresentation(record, requestId)
  }
  return null
}

function permissionPresentation(
  record: Record<string, unknown>,
  requestId: string | null
): ZcodeInteractionPresentation {
  const toolName = readString(record.toolName) ?? 'tool'
  const options = Array.isArray(record.options) ? record.options : []
  const journalOptions: AgentJournalPromptOption[] = options.flatMap((entry) => {
    const option = readRecord(entry)
    const optionId = readString(option?.optionId)
    const label = readString(option?.name) ?? optionId
    return optionId && label ? [{ id: optionId, label }] : []
  })
  const reason = readString(record.reason)
  const body: AgentJournalApprovalItem = {
    kind: 'approval',
    title: `Allow ${toolName}?`,
    displayName: toolName,
    ...(reason ? { description: reason } : {}),
    detail: toolInputDetail(record.input),
    options: journalOptions,
    resolution: pendingResolution()
  }
  return {
    body,
    requestId,
    interactive: true,
    reply: (response) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      const chosen = response as { kind?: unknown; optionId?: unknown } | null
      if (!chosen || chosen.kind !== 'option') {
        return { decision: 'deny', reason: 'cancelled by user' }
      }
      const selected = options.find((entry) => readRecord(entry)?.optionId === chosen.optionId)
      const decision =
        readString(readRecord(readRecord(selected)?.response)?.decision) ??
        (readString(readRecord(selected)?.kind)?.startsWith('allow') ? 'allow' : 'deny')
      return {
        decision,
        ...(decision === 'deny' ? { reason: 'denied by user' } : {})
      }
    }
  }
}

function planApprovalPresentation(
  record: Record<string, unknown>,
  requestId: string | null
): ZcodeInteractionPresentation {
  const plan = readString(readRecord(record.input)?.plan) ?? ''
  const body: AgentJournalApprovalItem = {
    kind: 'approval',
    title: 'Exit plan mode',
    subject: { kind: 'plan', text: plan },
    detail: null,
    options: [
      { id: 'approve', label: 'Approve — exit plan mode' },
      { id: 'reject', label: 'Reject — keep planning' }
    ],
    resolution: pendingResolution()
  }
  return {
    body,
    requestId,
    interactive: true,
    reply: (response) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      const chosen = response as { kind?: unknown; optionId?: unknown } | null
      if (!chosen || chosen.kind !== 'option' || chosen.optionId !== 'approve') {
        return { action: 'decline', reason: 'plan rejected' }
      }
      return { action: 'accept', content: { answer_0: 'approve' } }
    }
  }
}

function askUserPresentation(
  record: Record<string, unknown>,
  requestId: string | null
): ZcodeInteractionPresentation {
  const questions = Array.isArray(record.questions) ? record.questions : []
  const journalQuestions = questions.flatMap((entry, index) => {
    const question = readRecord(entry)
    const text = readString(question?.question)
    const multiSelect = question?.multiSelect === true
    const options = Array.isArray(question?.options) ? question.options : []
    const journalOptions = options.flatMap((optionEntry) => {
      const option = readRecord(optionEntry)
      const value = readString(option?.value)
      const label = readString(option?.label) ?? value
      return value && label ? [{ id: value, label }] : []
    })
    return text
      ? [
          {
            id: `q_${index}`,
            question: text,
            multiSelect,
            options: journalOptions
          }
        ]
      : []
  })
  const single = journalQuestions.length === 1 ? journalQuestions[0] : null
  const body: AgentJournalQuestionItem = single
    ? {
        kind: 'question',
        question: single.question,
        options: single.options,
        resolution: pendingResolution()
      }
    : {
        kind: 'question',
        question: journalQuestions.map((question) => question.question).join(' '),
        options: [],
        questions: journalQuestions,
        resolution: pendingResolution()
      }
  return {
    body,
    requestId,
    interactive: true,
    reply: (response) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      const answers = response as {
        kind?: unknown
        answers?: { questionId: string; optionIds: string[]; other?: string }[]
      } | null
      if (!answers || answers.kind !== 'answers') {
        return { action: 'decline', reason: 'cancelled' }
      }
      const content: Record<string, string> = {}
      for (const answer of answers.answers ?? []) {
        const question = journalQuestions.find((entry) => entry.id === answer.questionId)
        if (!question) {
          continue
        }
        const labels = answer.optionIds.flatMap((optionId) => {
          const option = question.options.find((entry) => entry.id === optionId)
          return option ? [option.label] : []
        })
        const others = answer.other?.trim() ? [answer.other.trim()] : []
        const value = [...labels, ...others].join(', ')
        if (value) {
          content[question.question] = value
        }
      }
      return { action: 'accept', content: { answers: content } }
    }
  }
}

function pendingResolution() {
  return {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

function toolInputDetail(input: unknown): string | null {
  if (input === undefined || input === null) {
    return null
  }
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    if (!text) {
      return null
    }
    return text.length > TOOL_INPUT_HEAD_BYTES ? `${text.slice(0, TOOL_INPUT_HEAD_BYTES)}…` : text
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
