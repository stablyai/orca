import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'

export const MAX_PROVIDER_ACTIVITY_LENGTH = 160

type ActivityText = string | null | undefined

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function redactSecrets(text: string): string | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)) {
    return null
  }
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|secret|password|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1$2[redacted]'
    )
}

/** Keep only a short sentence-shaped preview from provider-declared display fields. */
export function providerActivityText(value: unknown): string | null {
  const normalized = normalizeOptionalField(value, MAX_PROVIDER_ACTIVITY_LENGTH + 1)
  if (!normalized) {
    return null
  }
  const unwrapped = normalized
    .replace(/^(?:#{1,6}|[-+])\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^`(.+)`$/, '$1')
    .trim()
  if (
    !unwrapped ||
    /^[{[]/.test(unwrapped) ||
    /^[\w.-]+\s*[·-]\s*(?:notification:|message:|item\/)/i.test(unwrapped) ||
    (/^[\w:./-]+$/.test(unwrapped) && /[:/]/.test(unwrapped)) ||
    !/\p{L}/u.test(unwrapped)
  ) {
    return null
  }
  const redacted = redactSecrets(unwrapped)
  if (!redacted) {
    return null
  }
  const characters = Array.from(redacted)
  if (characters.length <= MAX_PROVIDER_ACTIVITY_LENGTH) {
    return redacted
  }
  const head = characters.slice(0, MAX_PROVIDER_ACTIVITY_LENGTH - 1).join('')
  const boundary = head.lastIndexOf(' ')
  const clipped = boundary >= MAX_PROVIDER_ACTIVITY_LENGTH * 0.6 ? head.slice(0, boundary) : head
  return `${clipped.trimEnd()}…`
}

const CODEX_ITEM_ACTIVITY: Readonly<Record<string, string>> = {
  agentMessage: 'Drafting a response',
  plan: 'Updating the plan',
  reasoning: 'Thinking through the request',
  commandExecution: 'Running a command',
  fileChange: 'Editing files',
  mcpToolCall: 'Using an external tool',
  dynamicToolCall: 'Using an external tool',
  functionCallOutput: 'Reviewing tool results',
  collabAgentToolCall: 'Coordinating with another agent',
  subAgentActivity: 'Coordinating with another agent',
  webSearch: 'Searching the web',
  imageView: 'Inspecting an image',
  imageGeneration: 'Generating an image',
  enteredReviewMode: 'Reviewing changes',
  exitedReviewMode: 'Reviewing changes',
  contextCompaction: 'Compacting the conversation',
  sleep: 'Waiting briefly',
  hookPrompt: 'Processing workspace guidance'
}

export function codexProviderFrameActivity(
  method: string,
  payload: unknown,
  reasoningText?: string | null
): ActivityText {
  const source = record(payload)
  if (method === 'item/mcpToolCall/progress') {
    return providerActivityText(stringField(source, 'message'))
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    return providerActivityText(reasoningText)
  }
  if (method === 'item/reasoning/summaryPartAdded') {
    return null
  }
  if (method !== 'item/started') {
    return undefined
  }
  const item = record(source?.item)
  const itemType = stringField(item, 'type')
  return itemType ? (CODEX_ITEM_ACTIVITY[itemType] ?? null) : null
}

export function claudeProviderFrameActivity(kind: string, payload: unknown): ActivityText {
  const source = record(payload)
  if (kind === 'message:system:task_started') {
    if (source?.ambient === true || source?.skip_transcript === true) {
      return null
    }
    const description = providerActivityText(stringField(source, 'description'))
    return description ? providerActivityText(`Working on: ${description}`) : null
  }
  if (kind === 'message:system:task_progress') {
    return providerActivityText(
      stringField(source, 'summary') ?? stringField(source, 'description')
    )
  }
  if (kind === 'message:system:task_updated') {
    return providerActivityText(stringField(record(source?.patch), 'description'))
  }
  if (kind === 'message:system:status') {
    const status = stringField(source, 'status')
    return status === 'compacting'
      ? 'Compacting the conversation'
      : status === 'requesting'
        ? 'Requesting a response'
        : null
  }
  if (kind === 'message:system:control_request_progress') {
    const status = stringField(source, 'status')
    return status === 'started'
      ? 'Exploring a side question'
      : status === 'api_retry'
        ? 'Retrying a side question'
        : null
  }
  if (kind === 'message:tool_progress') {
    return null
  }
  return undefined
}
