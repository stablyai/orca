// Agent permission asks (e.g. Claude/Codex "Do you want to proceed?") surface
// as plain TUI text in the agent's last assistant message — there is no
// structured permission event on mobile. We detect them heuristically so the
// native chat can render tappable Allow/Deny buttons instead of forcing the
// user to type into the composer. Be conservative: only fire when the agent is
// actually paused (blocked/waiting) AND the text reads like an approval ask.

/** A detected permission prompt, rendered as a card with tappable options.
 *  Each option's `send` is the literal string to write back to the agent
 *  (e.g. "y", "1") when the user taps it. */
export type MobileChatPermission = {
  title: string
  detail?: string
  options: Array<{ label: string; send: string }>
}

const ESCAPE = String.fromCharCode(27)

/** Parse the live `agentStatus.interactivePrompt` approval envelope
 *  (`{ approval: { tool, summary } }`, emitted by the host on a PermissionRequest)
 *  into an Allow/Deny card. This is the reliable, agent-emitted signal — unlike
 *  detectAgentPermission it doesn't depend on heuristic text parsing. The default
 *  sends (number for allow, Escape for deny) match the common TUI approval prompt;
 *  detectAgentPermission still takes precedence when it can read the real numbered
 *  options from the prompt text. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null
): MobileChatPermission | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const approval = (parsed as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') {
    return null
  }
  const tool = (approval as { tool?: unknown }).tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = (approval as { summary?: unknown }).summary
  return {
    title: `Allow ${tool}?`,
    detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
    options: [
      { label: 'Allow', send: '1' },
      { label: 'Deny', send: ESCAPE }
    ]
  }
}

type PermissionInput = {
  state?: string
  lastAssistantMessage?: string
  toolName?: string
  toolInput?: unknown
}

// States where the agent is paused waiting on the human. Only these can yield a
// permission prompt — a "working" agent is mid-turn and must not be answered.
const PAUSED_STATES: ReadonlySet<string> = new Set(['blocked', 'waiting'])

// Phrases that read as an approval request. Kept broad but anchored to
// approval/permission language so ordinary prose doesn't trip detection.
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

// A numbered-choice prompt like "1. Yes  2. No" / "2) No, and tell Claude…".
// Captures the option number and its label so we can send the literal digit.
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

// Whether a label reads as "allow for every future call" rather than just once.
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

/**
 * Heuristically detect an agent permission ask from its paused-state context.
 * Returns a renderable prompt, or null when the agent is working or the text
 * doesn't read like an approval request.
 */
export function detectAgentPermission(input: PermissionInput): MobileChatPermission | null {
  // Only answer a genuinely paused agent. A working agent is mid-turn.
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

  // Prefer an explicit numbered menu ("1. Yes  2. No, and tell…") — its labels
  // and send-digits come straight from the agent, so no guessing.
  const numbered = parseNumberedOptions(text)
  if (numbered.length >= 2) {
    return buildNumberedPermission(numbered, detail)
  }

  // Otherwise fall back to a y/n prompt. We surface "Allow always" only when the
  // text actually offers a persistent option, to avoid sending a token the agent
  // doesn't understand.
  const options: MobileChatPermission['options'] = [
    { label: 'Allow', send: 'y' },
    { label: 'Deny', send: 'n' }
  ]
  if (isAlwaysLabel(text)) {
    options.splice(1, 0, { label: 'Allow always', send: 'a' })
  }

  return { title: 'Permission requested', detail, options }
}
