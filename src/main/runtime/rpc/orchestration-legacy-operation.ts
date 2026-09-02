import { createHash, randomUUID } from 'node:crypto'
import type { RpcRequest } from './core'
import type { MessageType } from '../orchestration/db'
import { MESSAGE_TYPES } from '../orchestration/types'
import type { LegacyCompatibilityPrincipalRow, MessageRow } from '../orchestration/types'
import { OrchestrationError } from '../orchestration/orchestration-error'

const MESSAGE_TYPE_SET = new Set<string>(MESSAGE_TYPES)

export type LegacySendParams = {
  from?: string
  to?: string
  subject: string
  body?: string
  type?: string
  priority?: 'normal' | 'high' | 'urgent'
  payload?: string
}

export type LegacyCheckParams = {
  terminal?: string
  run?: string
  unread?: boolean
  peek?: boolean
  all?: boolean
  types?: string
  format?: boolean
  inject?: boolean
  wait?: boolean
  timeoutMs?: number
  compatibilityAck?: string
  compatibilityQuestionAck?: string
  compatibilityCliCommand?: 'orca' | 'orca-ide' | 'orca-dev'
}

export type LegacyAskParams = {
  from?: string
  to?: string
  run?: string
  question?: string
  resume?: string
  options?: string
  timeoutMs?: number
  compatibilityCliCommand?: 'orca' | 'orca-ide' | 'orca-dev'
  compatibilityWindowsCommand?: 'orca' | 'orca-ide'
}

export type LegacyReplyParams = {
  id: string
  body: string
  from?: string
  run?: string
}

export function operationIdentity(
  request: RpcRequest,
  method: string,
  payload: unknown
): { key: string; payloadHash: string } {
  const canonical = JSON.stringify(canonicalize(payload))
  const payloadHash = createHash('sha256').update(canonical).digest('hex')
  const semantic =
    method === 'worker_done' || method === 'reply' || method === 'ask'
      ? `${method}:${payloadHash}`
      : `${method}:${randomUUID()}`
  return {
    key: request.compatibilityInvocationId
      ? `invocation:${request.compatibilityInvocationId}`
      : `semantic:${semantic}`,
    payloadHash
  }
}

export function parseLegacyPayload(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall through to one stable validation error.
  }
  throw new OrchestrationError('invalid_argument', 'Message payload must be valid JSON.')
}

export function parseLegacyMailAck(raw: string): { messageIds: string[]; types?: MessageType[] } {
  try {
    const parsed: unknown = JSON.parse(raw)
    const messageIds = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { messageIds?: unknown }).messageIds
        : undefined
    const types =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { types?: unknown }).types
        : undefined
    if (
      Array.isArray(messageIds) &&
      messageIds.length > 0 &&
      messageIds.every((value) => typeof value === 'string' && value.length > 0) &&
      (types === undefined ||
        (Array.isArray(types) &&
          types.every((value) => typeof value === 'string' && MESSAGE_TYPE_SET.has(value))))
    ) {
      return {
        messageIds,
        types: types && types.length > 0 ? (types as MessageType[]) : undefined
      }
    }
  } catch {
    // Fall through to one stable validation error.
  }
  throw new OrchestrationError('invalid_argument', 'Invalid compatibility acknowledgment.')
}

export function parseLegacyQuestionAck(raw: string): {
  questionId: string
  answerMessageId: string
} {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { questionId?: unknown }).questionId === 'string' &&
      typeof (parsed as { answerMessageId?: unknown }).answerMessageId === 'string'
    ) {
      return parsed as { questionId: string; answerMessageId: string }
    }
  } catch {
    // Fall through to one stable validation error.
  }
  throw new OrchestrationError('invalid_argument', 'Invalid legacy question acknowledgment.')
}

export function parseLegacyTypes(raw: string | undefined): MessageType[] | undefined {
  const values = raw
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const invalidValues = values?.filter((value) => !MESSAGE_TYPE_SET.has(value))
  if (invalidValues && invalidValues.length > 0) {
    throw new OrchestrationError('invalid_argument', `Invalid --types: ${invalidValues.join(',')}`)
  }
  return values && values.length > 0 ? (values as MessageType[]) : undefined
}

export function parseLegacyOptions(raw: string | undefined): string[] {
  return (
    raw
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  )
}

export function supportedLegacyHints(
  message: MessageRow,
  principal: LegacyCompatibilityPrincipalRow,
  cliCommand: 'orca' | 'orca-ide' | 'orca-dev'
): string[] {
  if (
    principal.role !== 'coordinator' ||
    (message.type !== 'question' && message.type !== 'decision_gate')
  ) {
    return []
  }
  return [
    `${cliCommand} orchestration reply --id ${message.id} --from ${principal.terminal_handle} --body "..."`
  ]
}

export function inferLegacyWorkerOutcome(subject: string): 'succeeded' | 'failed' {
  const normalized = subject.trim()
  return normalized === 'Failed' || normalized.startsWith('Failed:') ? 'failed' : 'succeeded'
}

export function isWorkerOutcome(value: unknown): value is 'succeeded' | 'failed' {
  return value === 'succeeded' || value === 'failed'
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function normalizeLegacyText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, canonicalize(source[key])])
  )
}
