import { antigravityHistoryPromptHash } from '../ai-vault/scanners/antigravity/antigravity-history-prompt'
import { parseJsonObject } from '../ai-vault/parsing/session-json-object'
import { ensureNumber } from '../usage/source-input/usage-record-coercion'
import { extractString } from '../../shared/text/trimmed-string'
import type { AntigravityOpeningPrompt, AntigravityUsageParsedStep } from './types'

const SUBAGENT_MARKER = 'Created the following subagent:'
const SUBAGENT_ID_PATTERN =
  /Created the following subagent:\s*\{[^{}]*?"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi

const TOKEN_FIELDS = [
  'input_tokens',
  'cache_read_tokens',
  'output_tokens',
  'thinking_output_tokens'
] as const

export type AntigravityTranscriptParseAccumulator = {
  conversationId: string
  openingPrompt: AntigravityOpeningPrompt | null
  childConversationIds: Set<string>
  stepsByKey: Map<string, AntigravityUsageParsedStep>
  unindexedOrdinal: number
}

export function createAntigravityTranscriptAccumulator(
  conversationId: string
): AntigravityTranscriptParseAccumulator {
  return {
    conversationId,
    openingPrompt: null,
    childConversationIds: new Set<string>(),
    stepsByKey: new Map<string, AntigravityUsageParsedStep>(),
    unindexedOrdinal: 0
  }
}

function validIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function extractUserRequestBody(content: string): string | null {
  const opener = '<USER_REQUEST>'
  const start = content.indexOf(opener)
  if (start === -1) {
    return extractString(content)
  }
  const bodyStart = start + opener.length
  const end = content.indexOf('</USER_REQUEST>', bodyStart)
  return extractString(end === -1 ? content.slice(bodyStart) : content.slice(bodyStart, end))
}

function hasMeasuredTokenField(entry: Record<string, unknown>): boolean {
  return TOKEN_FIELDS.some((field) => {
    const value = entry[field]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
  })
}

function collectSubagentIds(content: string, acc: AntigravityTranscriptParseAccumulator): void {
  SUBAGENT_ID_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SUBAGENT_ID_PATTERN.exec(content)) !== null) {
    const childId = match[1]?.toLowerCase()
    if (childId && childId !== acc.conversationId.toLowerCase()) {
      acc.childConversationIds.add(childId)
    }
  }
}

function consumePlannerStep(
  entry: Record<string, unknown>,
  acc: AntigravityTranscriptParseAccumulator
): void {
  if (typeof entry.status === 'string' && entry.status !== 'DONE') {
    return
  }
  const timestamp = validIsoTimestamp(entry.created_at)
  if (!timestamp || !hasMeasuredTokenField(entry)) {
    return
  }
  const freshInputTokens = ensureNumber(entry.input_tokens)
  const cachedInputTokens = ensureNumber(entry.cache_read_tokens)
  // agy reports fresh input and cache reads as separate buckets; shared rollups expect cached inside input.
  const inputTokens = freshInputTokens + cachedInputTokens
  const outputTokens = ensureNumber(entry.output_tokens)
  // Thinking tokens are already included in output_tokens when reported.
  const reasoningOutputTokens = Math.min(ensureNumber(entry.thinking_output_tokens), outputTokens)
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) {
    return
  }
  const stepIndex =
    typeof entry.step_index === 'number' &&
    Number.isInteger(entry.step_index) &&
    entry.step_index >= 0
      ? entry.step_index
      : null
  const stepSlot = stepIndex !== null ? `step:${stepIndex}` : `ord:${acc.unindexedOrdinal++}`

  // Amended/retried steps reuse step_index; later completed records replace earlier ones.
  acc.stepsByKey.set(stepSlot, {
    timestamp,
    eventKey: [
      acc.conversationId,
      stepSlot,
      timestamp,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens
    ].join(':'),
    model: extractString(entry.model) ?? null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  })
}

export function consumeAntigravityUsageLine(
  line: string,
  acc: AntigravityTranscriptParseAccumulator
): void {
  const checkPrompt = acc.openingPrompt === null && line.includes('USER_INPUT')
  const checkSubagent = line.includes(SUBAGENT_MARKER)
  const checkPlanner = line.includes('PLANNER_RESPONSE')
  if (!checkPrompt && !checkSubagent && !checkPlanner) {
    return
  }
  const entry = parseJsonObject(line)
  if (!entry) {
    return
  }

  if (checkPrompt && entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
    const prompt = extractUserRequestBody(entry.content)
    const hash = prompt ? antigravityHistoryPromptHash(prompt) : null
    const timestamp = validIsoTimestamp(entry.created_at)
    if (hash && timestamp) {
      acc.openingPrompt = { hash, timestamp }
    }
  }

  if (checkSubagent && typeof entry.content === 'string') {
    collectSubagentIds(entry.content, acc)
  }

  if (checkPlanner && entry.type === 'PLANNER_RESPONSE') {
    consumePlannerStep(entry, acc)
  }
}
