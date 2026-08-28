import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat-types'

const ROLES = new Set(['user', 'assistant', 'tool', 'reasoning', 'system'])
const TOOL_STATES = new Set(['running', 'completed', 'failed'])
const RESOLUTION_STATES = new Set(['pending', 'resolved', 'cancelled'])
const DISPATCH_STATES = new Set(['pending', 'accepted', 'rejected', 'unknown'])

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isOptionalTrue(value: unknown): boolean {
  return value === undefined || value === true
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isAgentSessionProviderHandle(value: unknown): value is AgentSessionProviderHandle {
  if (!isRecord(value)) {
    return false
  }
  if (value.kind === 'codex') {
    return isNonEmptyString(value.threadId)
  }
  if (value.kind === 'claude') {
    return isNonEmptyString(value.sessionId) && isNullableString(value.leafUuid)
  }
  return value.kind === 'opaque' && isNonEmptyString(value.agent) && isNonEmptyString(value.value)
}

function isNativeChatBlock(value: unknown): value is NativeChatBlock {
  if (!isRecord(value)) {
    return false
  }
  if (value.type === 'text') {
    return typeof value.text === 'string'
  }
  if (value.type === 'tool-call') {
    return typeof value.name === 'string' && hasOwn(value, 'input')
  }
  if (value.type === 'tool-result') {
    return (
      typeof value.output === 'string' &&
      (value.isError === undefined || typeof value.isError === 'boolean')
    )
  }
  return (
    value.type === 'image-ref' &&
    isOptionalString(value.path) &&
    isOptionalString(value.url) &&
    isOptionalString(value.alt)
  )
}

function isBoundedPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.head === 'string' &&
    isNonNegativeInteger(value.byteLength) &&
    typeof value.digest === 'string' &&
    typeof value.truncated === 'boolean'
  )
}

function isPromptOption(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) && typeof value.label === 'string'
}

function isResolution(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.state === 'string' &&
    RESOLUTION_STATES.has(value.state) &&
    isNullableString(value.selectedOptionId) &&
    isNullableString(value.resolvedBy) &&
    isNullableNumber(value.resolvedAt)
  )
}

export function isAgentJournalItemBody(value: unknown): value is AgentJournalItemBody {
  if (!isRecord(value)) {
    return false
  }
  if (value.kind === 'message') {
    return (
      typeof value.role === 'string' &&
      ROLES.has(value.role) &&
      Array.isArray(value.blocks) &&
      value.blocks.every(isNativeChatBlock)
    )
  }
  if (value.kind === 'tool-call') {
    return (
      typeof value.name === 'string' &&
      hasOwn(value, 'input') &&
      typeof value.state === 'string' &&
      TOOL_STATES.has(value.state) &&
      (value.output === undefined || isBoundedPayload(value.output))
    )
  }
  if (value.kind === 'diff') {
    return typeof value.path === 'string' && isBoundedPayload(value.patch)
  }
  if (value.kind === 'approval') {
    return (
      typeof value.title === 'string' &&
      isNullableString(value.detail) &&
      Array.isArray(value.options) &&
      value.options.every(isPromptOption) &&
      isResolution(value.resolution)
    )
  }
  if (value.kind === 'question') {
    return (
      typeof value.question === 'string' &&
      Array.isArray(value.options) &&
      value.options.every(isPromptOption) &&
      isResolution(value.resolution)
    )
  }
  return value.kind === 'status' && typeof value.text === 'string'
}

export function isJournalRenderItem(value: unknown): value is AgentJournalRenderItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.itemId) &&
    isNonNegativeInteger(value.revision) &&
    isAgentJournalItemBody(value.body) &&
    Number.isInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    isFiniteNumber(value.observedAt) &&
    isOptionalTrue(value.recovered)
  )
}

export function isJournalSubmission(value: unknown): value is AgentJournalSubmission {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.clientMessageId) ||
    !isNonNegativeInteger(value.fence) ||
    typeof value.payloadFingerprint !== 'string' ||
    typeof value.dispatchState !== 'string' ||
    !DISPATCH_STATES.has(value.dispatchState) ||
    !isNullableString(value.providerItemId) ||
    !isNullableString(value.reason) ||
    !isFiniteNumber(value.submittedAt) ||
    !isNullableNumber(value.resolvedAt)
  ) {
    return false
  }
  if (value.dispatchState === 'pending') {
    return value.providerItemId === null && value.reason === null && value.resolvedAt === null
  }
  if (value.dispatchState === 'accepted') {
    return (
      isNonEmptyString(value.providerItemId) &&
      value.reason === null &&
      isFiniteNumber(value.resolvedAt)
    )
  }
  return value.providerItemId === null && isFiniteNumber(value.resolvedAt)
}

export function isJournalTombstone(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.itemId) && isNonNegativeInteger(value.revision)
}

export function isJournalReceipt(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.clientMessageId) &&
    isNonEmptyString(value.providerItemId) &&
    isNonEmptyString(value.epoch) &&
    Number.isInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    isFiniteNumber(value.acceptedAt)
  )
}

export function isJournalAlias(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.providerItemId) && isNonEmptyString(value.itemId)
}
