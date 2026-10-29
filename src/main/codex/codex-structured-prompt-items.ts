import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalPromptOption,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { boundInlineText } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { boundJournalPromptText } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  CODEX_APPROVAL_DECISIONS,
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  codexJournalPromptIdPart,
  encodeCodexJournalQuestionOptionId,
  type CodexApprovalDecision
} from './codex-structured-prompt-replies'
import { codexMcpToolApprovalDecisions } from './codex-mcp-tool-approval'

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
const PROMPT_OPTION_LIMITS = { inlineHeadBytes: 1024 }

function readParams(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function boundNullablePromptText(value: string | null): string | null {
  return value === null ? null : boundJournalPromptText(value)
}

function boundPromptOptionLabel(value: string): string {
  return boundInlineText(value, PROMPT_OPTION_LIMITS).text
}

/** Older providers omit availableDecisions; fall back to all supported decisions. */
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
  /** Fallback from the announced item when the approval request omits its detail. */
  detail: string | null
}): AgentJournalApprovalItem {
  const params = readParams(input.params)
  if (input.method === CODEX_MCP_ELICITATION_METHOD) {
    return codexMcpToolApprovalItem(params)
  }
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

function codexMcpToolApprovalItem(params: Record<string, unknown>): AgentJournalApprovalItem {
  const toolParams = readParams(params._meta).tool_params
  return {
    kind: 'approval',
    title: boundJournalPromptText(readString(params, 'message') ?? 'Allow this tool call?'),
    detail: toolParams === undefined ? null : boundJournalPromptText(JSON.stringify(toolParams)),
    options: codexMcpToolApprovalDecisions(params).map((decision) => ({
      id: decision,
      // MCP cancel skips only this call and the turn continues, so it reads as Deny, not Stop.
      label: APPROVAL_DECISION_LABELS[decision === 'cancel' ? 'decline' : decision]
    })),
    resolution: { ...PENDING }
  }
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

/** Each question needs independent answer arbitration; Codex receives one combined reply. */
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
        question: boundJournalPromptText(prompt),
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
      // Clients return option IDs; encode the question needed by Codex's answer map.
      mapped.push({
        id: encodeCodexJournalQuestionOptionId(questionId, label),
        label: boundPromptOptionLabel(label)
      })
    }
  }
  return mapped
}

/** Use Orca keys for nonpersisted prompts; one tool item can issue several distinct asks. */
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
