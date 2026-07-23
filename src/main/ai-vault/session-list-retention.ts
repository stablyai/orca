import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'

export const AI_VAULT_SESSION_ID_MAX_UTF8_BYTES = 64 * 1024
export const AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES = 128 * 1024
export const AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES = 4 * 1024
export const AI_VAULT_SESSION_MAX_JSON_BYTES = 1024 * 1024
export const AI_VAULT_SESSION_LIST_MAX_JSON_BYTES = 32 * 1024 * 1024
export const AI_VAULT_SESSION_LIST_CACHE_KEY_MAX_JSON_BYTES = 256 * 1024
export const AI_VAULT_SCAN_ISSUE_MAX_ENTRIES = 1024

const AI_VAULT_SESSION_DERIVED_FIELD_MAX_UTF8_BYTES = 512 * 1024
const AI_VAULT_SCAN_ISSUE_FIELD_MAX_UTF8_BYTES = 16 * 1024
const AI_VAULT_SCAN_ISSUE_MAX_JSON_BYTES = 64 * 1024
const AI_VAULT_SESSION_PREVIEW_MAX_MESSAGES = 5
const TRUNCATION_MARKER = '...'

export class AiVaultSessionCapacityError extends Error {
  constructor(field: string, maxBytes: number) {
    super(`AI Vault omitted a session because its ${field} exceeds the ${maxBytes} byte limit.`)
    this.name = 'AiVaultSessionCapacityError'
  }
}

export function retainAiVaultSession(session: AiVaultSession): AiVaultSession {
  requireField(session.executionHostId, 64 * 1024, 'execution host id')
  requireField(session.sessionId, AI_VAULT_SESSION_ID_MAX_UTF8_BYTES, 'session id')
  requireField(session.cwd, AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES, 'working directory')
  requireField(session.filePath, AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES, 'transcript path')
  requireField(session.codexHome, AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES, 'Codex home')
  requireField(session.id, AI_VAULT_SESSION_DERIVED_FIELD_MAX_UTF8_BYTES, 'derived id')
  requireField(
    session.resumeCommand,
    AI_VAULT_SESSION_DERIVED_FIELD_MAX_UTF8_BYTES,
    'resume command'
  )
  if (session.subagent) {
    requireField(
      session.subagent.parentSessionId,
      AI_VAULT_SESSION_ID_MAX_UTF8_BYTES,
      'parent session id'
    )
  }

  const title = truncateUtf8(session.title, AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES)
  const branch = truncateNullableUtf8(session.branch, AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES)
  const model = truncateNullableUtf8(session.model, AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES)
  const lastUserPrompt = truncateNullableUtf8(
    session.lastUserPrompt,
    AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES
  )
  const previewSource =
    session.previewMessages.length > AI_VAULT_SESSION_PREVIEW_MAX_MESSAGES
      ? session.previewMessages.slice(-AI_VAULT_SESSION_PREVIEW_MAX_MESSAGES)
      : session.previewMessages
  const previewMessages = previewSource.map((message) => {
    const text = truncateUtf8(message.text, AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES)
    return text === message.text ? message : { ...message, text }
  })
  const agentType = session.subagent
    ? truncateNullableUtf8(
        session.subagent.agentType,
        AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES
      )
    : undefined
  const changed =
    title !== session.title ||
    branch !== session.branch ||
    model !== session.model ||
    lastUserPrompt !== session.lastUserPrompt ||
    previewSource !== session.previewMessages ||
    previewMessages.some((message, index) => message !== session.previewMessages[index]) ||
    agentType !== session.subagent?.agentType
  const retained = changed
    ? {
        ...session,
        title,
        branch,
        model,
        ...(session.lastUserPrompt === undefined ? {} : { lastUserPrompt }),
        previewMessages,
        ...(session.subagent
          ? { subagent: { ...session.subagent, agentType: agentType ?? null } }
          : {})
      }
    : session
  try {
    stringifyJsonWithinByteLimit(retained, AI_VAULT_SESSION_MAX_JSON_BYTES)
  } catch {
    throw new AiVaultSessionCapacityError('serialized metadata', AI_VAULT_SESSION_MAX_JSON_BYTES)
  }
  return retained
}

export function retainAiVaultSessionsWithinAggregate(
  sessions: readonly AiVaultSession[],
  maxBytes: number = AI_VAULT_SESSION_LIST_MAX_JSON_BYTES
): {
  sessions: AiVaultSession[]
  omitted: number
} {
  const limit = boundedListLimit(maxBytes)
  const retained: AiVaultSession[] = []
  let retainedBytes = 2
  let omitted = 0
  for (let index = 0; index < sessions.length; index += 1) {
    try {
      const session = retainAiVaultSession(sessions[index])
      const bytes = stringifyJsonWithinByteLimit(
        session,
        AI_VAULT_SESSION_MAX_JSON_BYTES
      ).byteLength
      const nextBytes = retainedBytes + bytes + (retained.length > 0 ? 1 : 0)
      if (nextBytes > limit) {
        omitted += sessions.length - index
        break
      }
      retained.push(session)
      retainedBytes = nextBytes
    } catch {
      omitted++
    }
  }
  return { sessions: retained, omitted }
}

export function boundAiVaultListResult(
  result: AiVaultListResult,
  maxBytes: number = AI_VAULT_SESSION_LIST_MAX_JSON_BYTES
): AiVaultListResult {
  const limit = boundedListLimit(maxBytes)
  const scannedAt = truncateUtf8(result.scannedAt, 256)
  const baseBytes = stringifyJsonWithinByteLimit(
    { sessions: [], issues: [], scannedAt },
    limit
  ).byteLength
  const sessions: AiVaultSession[] = []
  const sessionBytes: number[] = []
  const issues: AiVaultScanIssue[] = []
  const issueBytes: number[] = []
  let retainedBytes = baseBytes
  let omittedSessions = 0
  let omittedIssues = 0
  let firstOmittedAgent: AiVaultScanIssue['agent'] | null = null
  let changed = scannedAt !== result.scannedAt

  for (let index = 0; index < result.sessions.length; index += 1) {
    try {
      const session = retainAiVaultSession(result.sessions[index])
      const bytes = stringifyJsonWithinByteLimit(
        session,
        AI_VAULT_SESSION_MAX_JSON_BYTES
      ).byteLength
      const nextBytes = retainedBytes + bytes + (sessions.length > 0 ? 1 : 0)
      if (nextBytes > limit) {
        omittedSessions += result.sessions.length - index
        firstOmittedAgent ??= session.agent
        changed = true
        break
      }
      sessions.push(session)
      sessionBytes.push(bytes)
      retainedBytes = nextBytes
      changed ||= session !== result.sessions[index]
    } catch {
      omittedSessions++
      firstOmittedAgent ??= result.sessions[index].agent
      changed = true
    }
  }

  for (let index = 0; index < result.issues.length; index += 1) {
    if (issues.length >= AI_VAULT_SCAN_ISSUE_MAX_ENTRIES) {
      omittedIssues += result.issues.length - index
      changed = true
      break
    }
    const issue = retainScanIssue(result.issues[index])
    const bytes = stringifyJsonWithinByteLimit(issue, AI_VAULT_SCAN_ISSUE_MAX_JSON_BYTES).byteLength
    const nextBytes = retainedBytes + bytes + (issues.length > 0 ? 1 : 0)
    if (nextBytes > limit) {
      omittedIssues += result.issues.length - index
      changed = true
      break
    }
    issues.push(issue)
    issueBytes.push(bytes)
    retainedBytes = nextBytes
    changed ||= issue !== result.issues[index]
  }

  if (omittedSessions > 0 || omittedIssues > 0) {
    let summary = overflowSummary(firstOmittedAgent, omittedSessions, omittedIssues)
    let summaryBytes = issueJsonBytes(summary)
    while (
      issues.length >= AI_VAULT_SCAN_ISSUE_MAX_ENTRIES ||
      retainedBytes + summaryBytes + (issues.length > 0 ? 1 : 0) > limit
    ) {
      if (issues.length > 0) {
        const removedBytes = issueBytes.pop() ?? 0
        issues.pop()
        retainedBytes -= removedBytes + (issues.length > 0 ? 1 : 0)
        omittedIssues++
      } else if (sessions.length > 0) {
        const removedBytes = sessionBytes.pop() ?? 0
        sessions.pop()
        retainedBytes -= removedBytes + (sessions.length > 0 ? 1 : 0)
        omittedSessions++
      } else {
        break
      }
      summary = overflowSummary(firstOmittedAgent, omittedSessions, omittedIssues)
      summaryBytes = issueJsonBytes(summary)
    }
    issues.push(summary)
  }

  return changed ? { sessions, issues, scannedAt } : result
}

export function aiVaultSessionListCacheKey(value: unknown): string | null {
  try {
    return stringifyJsonWithinByteLimit(value, AI_VAULT_SESSION_LIST_CACHE_KEY_MAX_JSON_BYTES)
      .serialized
  } catch {
    return null
  }
}

function retainScanIssue(issue: AiVaultScanIssue): AiVaultScanIssue {
  const executionHostId =
    issue.executionHostId &&
    !exceedsUtf8Bytes(issue.executionHostId, AI_VAULT_SCAN_ISSUE_FIELD_MAX_UTF8_BYTES)
      ? issue.executionHostId
      : undefined
  const path = truncateUtf8(issue.path, AI_VAULT_SCAN_ISSUE_FIELD_MAX_UTF8_BYTES)
  const message = truncateUtf8(issue.message, AI_VAULT_SCAN_ISSUE_FIELD_MAX_UTF8_BYTES)
  return executionHostId === issue.executionHostId &&
    path === issue.path &&
    message === issue.message
    ? issue
    : {
        ...issue,
        executionHostId,
        path,
        message
      }
}

function requireField(value: string | null, maxBytes: number, field: string): void {
  if (value !== null && exceedsUtf8Bytes(value, maxBytes)) {
    throw new AiVaultSessionCapacityError(field, maxBytes)
  }
}

function truncateNullableUtf8(value: string | null, maxBytes: number): string | null
function truncateNullableUtf8(
  value: string | null | undefined,
  maxBytes: number
): string | null | undefined
function truncateNullableUtf8(
  value: string | null | undefined,
  maxBytes: number
): string | null | undefined {
  return value == null ? value : truncateUtf8(value, maxBytes)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (!exceedsUtf8Bytes(value, maxBytes)) {
    return value
  }
  const prefixBytes = Math.max(0, maxBytes - TRUNCATION_MARKER.length)
  const end = utf8PrefixEnd(value, prefixBytes)
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`
}

function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return utf8PrefixEnd(value, maxBytes) < value.length
}

function utf8PrefixEnd(value: string, maxBytes: number): number {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const code = value.codePointAt(index) ?? 0
    const charBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes + charBytes > maxBytes) {
      break
    }
    bytes += charBytes
    index += code > 0xffff ? 2 : 1
  }
  return index
}

function overflowSummary(
  agent: AiVaultScanIssue['agent'] | null,
  omittedSessions: number,
  omittedIssues: number
): AiVaultScanIssue {
  return {
    agent: agent ?? 'codex',
    path: 'AI Vault session list',
    message: `AI Vault omitted ${omittedSessions} sessions and ${omittedIssues} scan issues because the result exceeded its memory limits.`
  }
}

function issueJsonBytes(issue: AiVaultScanIssue): number {
  return stringifyJsonWithinByteLimit(issue, AI_VAULT_SCAN_ISSUE_MAX_JSON_BYTES).byteLength
}

function boundedListLimit(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError('AI Vault session list limit must be a non-negative safe integer')
  }
  return Math.min(requested, AI_VAULT_SESSION_LIST_MAX_JSON_BYTES)
}
