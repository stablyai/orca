import { parseNativeChatApprovalEnvelope } from '../../../../../src/shared/native-chat-approval-envelope'
import type { AgentJournalApprovalSubject } from '../../../../../src/shared/agent-session-journal-types'
import { parseOmpPlanReviewPrompt } from '../../../../../src/shared/omp-plan-review-prompt'

// Use conservative paused-state heuristics only for terminal prompts; working-agent prose must never receive an approval response.

export type MobileChatPermission = {
  title: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  subject?: AgentJournalApprovalSubject
  detail?: string
  /** Structured prompt identity, present only when the host can cancel it exactly. */
  prompt?: { itemId: string; expectedRevision: number }
  options: Array<{ label: string; send: string }>
}

/** OMP's plan review envelope: exact agent-emitted options, so no heuristic may replace it. */
export function parseOmpPlanReviewFromStatus(
  interactivePrompt: string | undefined | null
): MobileChatPermission | null {
  const planReview = parseOmpPlanReviewPrompt(interactivePrompt)
  return planReview
    ? {
        title: 'Review proposed plan',
        description: 'Refine plan closes the review so you can send what to change.',
        subject: { kind: 'plan', text: planReview.plan },
        options: planReview.options
      }
    : null
}

// Prefer real numbered labels when present; the structured approval envelope provides a reliable fallback without heuristic prose matching.
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null,
  agent?: string
): MobileChatPermission | null {
  const envelope = parseNativeChatApprovalEnvelope(interactivePrompt, agent)
  if (!envelope) {
    return null
  }
  return {
    title: `Allow ${envelope.tool}?`,
    detail: envelope.summary,
    options: [
      { label: 'Allow', send: envelope.allowSend },
      { label: 'Deny', send: envelope.denySend }
    ]
  }
}

type PermissionInput = {
  state?: string
  lastAssistantMessage?: string
  toolName?: string
  toolInput?: unknown
}

// Only genuinely paused agents may receive permission answers.
const PAUSED_STATES: ReadonlySet<string> = new Set(['blocked', 'waiting'])

const PERMISSION_PATTERNS: RegExp[] = [
  /\bpermission\b/i,
  /\bapprove\b/i,
  /\bapproval\b/i,
  /\ballow\b/i,
  /\bdeny\b/i,
  /\bgrant\b/i,
  /\bauthorize\b/i,
  /\bdo you want to\b/i,
  /\bwould you like to\b/i,
  /\bproceed\?/i,
  /\bconfirm\b/i,
  /\(y\/n\)/i,
  /\by\/n\b/i,
  /\byes\/no\b/i,
  /\bplease confirm\b/i
]

function looksLikePermissionAsk(text: string): boolean {
  return PERMISSION_PATTERNS.some((re) => re.test(text))
}

const NUMBERED_OPTION_RE = /(?:^|\n)\s*(\d+)[.)]\s*([^\n]+)/g

type NumberedOption = { num: string; text: string }

function parseNumberedOptions(text: string): NumberedOption[] {
  const out: NumberedOption[] = []
  for (const match of text.matchAll(NUMBERED_OPTION_RE)) {
    const num = match[1]
    const body = match[2]?.trim()
    if (num && body) {
      out.push({ num, text: body })
    }
  }
  return out
}

function isAlwaysLabel(text: string): boolean {
  return /\balways\b|don't ask again|do not ask again|for the rest|this session/i.test(text)
}

function shortLabel(text: string, max = 40): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function buildNumberedPermission(
  options: NumberedOption[],
  detail: string | undefined
): MobileChatPermission {
  return {
    title: 'Permission requested',
    detail,
    options: options.map((opt) => ({ label: shortLabel(opt.text), send: opt.num }))
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

export function detectAgentPermission(input: PermissionInput): MobileChatPermission | null {
  if (!input.state || !PAUSED_STATES.has(input.state)) {
    return null
  }

  const text = typeof input.lastAssistantMessage === 'string' ? input.lastAssistantMessage : ''
  if (!text.trim()) {
    return null
  }

  if (!looksLikePermissionAsk(text)) {
    return null
  }

  const detail = shortLabel(firstLine(text), 160) || undefined

  const numbered = parseNumberedOptions(text)
  if (numbered.length >= 2) {
    return buildNumberedPermission(numbered, detail)
  }

  // Offer persistent approval only if the TUI actually names that option; invented tokens could answer incorrectly.
  const options: MobileChatPermission['options'] = [
    { label: 'Allow', send: 'y' },
    { label: 'Deny', send: 'n' }
  ]
  if (isAlwaysLabel(text)) {
    options.splice(1, 0, { label: 'Allow always', send: 'a' })
  }

  return { title: 'Permission requested', detail, options }
}
