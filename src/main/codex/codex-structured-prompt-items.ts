import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalPromptOption,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  CODEX_APPROVAL_DECISIONS,
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  codexJournalPromptIdPart,
  encodeCodexJournalQuestionOptionId,
  type CodexApprovalDecision
} from './codex-structured-prompt-replies'

// Codex prompt requests → durable journal items.
//
// Codex blocks the turn on these, but the answer may arrive minutes later from
// a different device, so the prompt has to exist as a journal item with its own
// resolution state rather than as live callback state. The reply path already
// lives in `codex-structured-prompt-replies.ts`; this is only the render model.

const APPROVAL_DECISION_LABELS: Record<CodexApprovalDecision, string> = {
  accept: 'Allow',
  acceptForSession: 'Allow for this session',
  decline: 'Deny',
  cancel: 'Stop'
}

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

const MAX_CODEX_PROMPT_QUESTIONS = 64
const MAX_CODEX_PROMPT_OPTIONS = 64
const PROMPT_OPTION_LIMITS = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 1024 }

function readParams(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function boundPromptText(value: string): string {
  return boundInlineText(value, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
}

function boundPromptOptionLabel(value: string): string {
  return boundInlineText(value, PROMPT_OPTION_LIMITS).text
}

/**
 * Codex offers a per-request decision set, so the options come off the request
 * when it names them. Falling back to the full set is deliberate: a build that
 * omits the field still accepts all four, and offering nothing would leave the
 * turn blocked with no way to answer it.
 */
export function codexApprovalOptions(params: unknown): AgentJournalPromptOption[] {
  const available = readParams(params).availableDecisions
  const offered = Array.isArray(available)
    ? available.filter((decision): decision is CodexApprovalDecision =>
        (CODEX_APPROVAL_DECISIONS as readonly unknown[]).includes(decision)
      )
    : []
  const decisions = offered.length > 0 ? offered : CODEX_APPROVAL_DECISIONS
  return decisions.map((decision) => ({ id: decision, label: APPROVAL_DECISION_LABELS[decision] }))
}

export function codexApprovalItem(input: {
  method: string
  params: unknown
  /** What is being approved, taken from the item Codex already announced —
   *  the approval request itself does not repeat the command or the patch. */
  detail: string | null
}): AgentJournalApprovalItem {
  const params = readParams(input.params)
  return {
    kind: 'approval',
    title:
      input.method === CODEX_FILE_CHANGE_APPROVAL_METHOD
        ? 'Apply file changes?'
        : input.method === CODEX_COMMAND_APPROVAL_METHOD
          ? 'Run a command?'
          : 'Approve this action?',
    detail: boundNullablePromptText(approvalDetail(params) ?? input.detail),
    options: codexApprovalOptions(input.params),
    resolution: { ...PENDING }
  }
}

function boundNullablePromptText(value: string | null): string | null {
  return value === null ? null : boundPromptText(value)
}

function approvalDetail(params: Record<string, unknown>): string | null {
  const command = params.command
  if (typeof command === 'string' && command.length > 0) {
    return command
  }
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    return command.join(' ')
  }
  const reason = readString(params, 'reason')
  if (reason) {
    return reason
  }
  const detail = params.grantRoot ?? params.changes
  return detail === undefined ? null : JSON.stringify(detail)
}

export type CodexQuestionItem = {
  questionId: string
  identity: AgentJournalItemIdentity
  body: AgentJournalQuestionItem
}

/**
 * One journal item per question, not one per request. Codex takes a single
 * reply covering every question, but a client answers them one at a time, and
 * each answer has to win its own compare-and-set — so each question needs its
 * own resolution state. The reply fires when the last one lands.
 */
export function codexQuestionItems(input: {
  threadId: string
  promptKey: string
  params: unknown
}): CodexQuestionItem[] {
  const questions = readParams(input.params).questions
  if (!Array.isArray(questions)) {
    return []
  }
  const items: CodexQuestionItem[] = []
  for (const entry of questions.slice(0, MAX_CODEX_PROMPT_QUESTIONS)) {
    const question = readParams(entry)
    const questionId = readString(question, 'id')
    const prompt = readString(question, 'question') ?? readString(question, 'header')
    if (!questionId || !prompt) {
      continue
    }
    items.push({
      questionId,
      identity: codexPromptIdentity({ ...input, questionId }),
      body: {
        kind: 'question',
        question: boundPromptText(prompt),
        options: questionOptions(question, questionId),
        ...(questionAllowsFreeText(question)
          ? { freeTextQuestionId: codexJournalPromptIdPart(questionId) }
          : {}),
        resolution: { ...PENDING }
      }
    })
  }
  return items
}

function questionAllowsFreeText(question: Record<string, unknown>): boolean {
  const options = question.options
  return (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((option) => readParams(option).isOther === true)
  )
}

function questionOptions(
  question: Record<string, unknown>,
  questionId: string
): AgentJournalPromptOption[] {
  const options = question.options
  if (!Array.isArray(options)) {
    return []
  }
  const mapped: AgentJournalPromptOption[] = []
  for (const entry of options) {
    if (mapped.length >= MAX_CODEX_PROMPT_OPTIONS) {
      break
    }
    const option = readParams(entry)
    const label = readString(option, 'label')
    if (label !== null && option.isOther !== true) {
      // The option id has to name its question: Codex's reply is a map keyed by
      // question id, and the client only ever hands back an option id.
      mapped.push({
        id: encodeCodexJournalQuestionOptionId(questionId, label),
        label: boundPromptOptionLabel(label)
      })
    }
  }
  return mapped
}

/** Prompts are live-session state Codex does not persist, so they are keyed in
 *  the Orca namespace rather than by `(threadId, turnId, ordinal)`. */
/** Keyed by the prompt, not by the tool item it is about: one shell item can
 *  ask several times, and each ask is its own journal row to answer. */
export function codexPromptIdentity(input: {
  threadId: string
  promptKey: string
  questionId?: string
}): AgentJournalItemIdentity {
  const suffix = input.questionId ? `:${codexJournalPromptIdPart(input.questionId)}` : ''
  const threadId = codexJournalPromptIdPart(input.threadId)
  const promptKey = codexJournalPromptIdPart(input.promptKey)
  return {
    provider: 'orca',
    clientMessageId: `codex-prompt:${threadId}:${promptKey}${suffix}`
  }
}
