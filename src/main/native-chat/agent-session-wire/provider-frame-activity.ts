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

/** A reasoning summary streams as a bold headline plus body; only the headline is activity copy. */
function reasoningHeadline(text: string | null | undefined): ActivityText {
  const line = text?.split(/\r?\n/).find((candidate) => candidate.trim())
  if (!line) {
    return null
  }
  // Hold the previous copy until the closing marker streams in; a half headline would flicker.
  return /^\s*\*\*/.test(line) && !/\*\*.+\*\*/.test(line) ? undefined : line
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
  const characters = Array.from(unwrapped)
  if (characters.length <= MAX_PROVIDER_ACTIVITY_LENGTH) {
    return unwrapped
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
    const headline = reasoningHeadline(reasoningText)
    return headline === undefined ? undefined : providerActivityText(headline)
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

/** Retain only the current summary headline, never materialize the growing transcript. */
export function createCodexProviderActivityReader(): (
  method: string,
  payload: unknown
) => ActivityText {
  let itemId: unknown
  let summaryIndex: unknown
  let headline = ''
  let complete = false
  const limit = MAX_PROVIDER_ACTIVITY_LENGTH * 2 + 16
  return (method, payload) => {
    if (
      method !== 'item/reasoning/summaryTextDelta' &&
      method !== 'item/reasoning/summaryPartAdded'
    ) {
      return codexProviderFrameActivity(method, payload)
    }
    const source = record(payload)
    if (!stringField(source, 'itemId')) {
      return undefined
    }
    if (
      source?.itemId !== itemId ||
      source?.summaryIndex !== summaryIndex ||
      method === 'item/reasoning/summaryPartAdded'
    ) {
      itemId = source?.itemId
      summaryIndex = source?.summaryIndex
      headline = ''
      complete = false
    }
    if (method === 'item/reasoning/summaryPartAdded') {
      return null
    }
    if (complete || typeof source?.delta !== 'string') {
      return undefined
    }
    headline += source.delta.slice(0, limit - headline.length)
    const line = headline.trimStart().split(/\r?\n/, 1)[0]
    complete =
      headline.length === limit || /\r?\n/.test(headline.trimStart()) || /^\*\*.+\*\*/.test(line)
    if (complete && line.startsWith('**') && !/\*\*.+\*\*/.test(line)) {
      return providerActivityText(line.slice(2))
    }
    return codexProviderFrameActivity(method, payload, line)
  }
}
