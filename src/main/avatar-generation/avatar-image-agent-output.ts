// Reading an image-capable agent's one-off run: where its image went, and why it failed.
import type { AvatarGenerationFailure } from '../../shared/avatar-generation/avatar-generation-contract'

const SAFE_ID = /^[A-Za-z0-9-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isRecord(value)) {
        records.push(value)
      }
    } catch {
      // Agents interleave plain log lines with their JSON events.
    }
  }
  return records
}

/** `codex exec --json` names its thread first; the image tool saves under that thread's id. */
export function codexThreadId(stdout: string): string | null {
  for (const record of jsonLines(stdout)) {
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') {
      // The id becomes a path segment, so only accept what Codex actually issues.
      return SAFE_ID.test(record.thread_id) ? record.thread_id : null
    }
  }
  return null
}

function collectConversationIds(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectConversationIds(entry, into))
    return
  }
  if (!isRecord(value)) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'conversation_id' && typeof entry === 'string') {
      if (SAFE_ID.test(entry) && !into.includes(entry)) {
        into.push(entry)
      }
    } else {
      collectConversationIds(entry, into)
    }
  }
}

/** agy's stream-json conversation ids, its own first: each names a folder under its home. */
export function antigravityConversationIds(stdout: string): string[] {
  const ids: string[] = []
  // Only ids that pass SAFE_ID become path segments.
  jsonLines(stdout).forEach((record) => collectConversationIds(record, ids))
  return ids
}

function grokToolPath(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && 'path' in value && typeof value.path === 'string') {
      return value.path
    }
  } catch {
    // Not the image tool's JSON reply.
  }
  return null
}

/** Grok's streaming JSON reports the saved image's path in the image tool's completed update. */
export function grokImagePaths(stdout: string): string[] {
  const imageCalls = new Set<string>()
  const paths: string[] = []
  for (const record of jsonLines(stdout)) {
    if (record.type === 'tool_call' && record.toolName === 'image_gen') {
      imageCalls.add(String(record.toolCallId))
      continue
    }
    if (
      record.type !== 'tool_call_update' ||
      record.status !== 'completed' ||
      !imageCalls.has(String(record.toolCallId)) ||
      !Array.isArray(record.content)
    ) {
      continue
    }
    for (const entry of record.content) {
      const content: unknown = isRecord(entry) ? entry.content : null
      const path =
        isRecord(content) && content.type === 'text' && typeof content.text === 'string'
          ? grokToolPath(content.text)
          : null
      if (path) {
        paths.push(path)
      }
    }
  }
  return paths
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') {
    return value
  }
  return isRecord(value) && typeof value.message === 'string' ? value.message : ''
}

/** Only error events' messages: usage events carry bare numbers like 401 or 429 tokens. */
export function agentErrorText(stdout: string): string {
  return jsonLines(stdout)
    .flatMap((record) => {
      if (record.type === 'error' || record.type === 'turn.failed' || record.event === 'error') {
        return [`${stringField(record, 'message')} ${stringField(record, 'error')}`]
      }
      // agy ends with one result event; anything but SUCCESS carries why.
      const result = record.event === 'result' ? record.result : null
      return isRecord(result) && result.status !== 'SUCCESS'
        ? [`${stringField(result, 'error')} ${stringField(result, 'response')}`]
        : []
    })
    .join('\n')
}

/** What the agent said back: Codex agent messages, Grok's streamed text, or agy's result. */
export function agentReplyText(stdout: string): string {
  return jsonLines(stdout)
    .map((record) => {
      if (record.type === 'text' && typeof record.data === 'string') {
        return record.data
      }
      if (record.event === 'result' && isRecord(record.result)) {
        return `${stringField(record.result, 'response')}\n`
      }
      const item = record.type === 'item.completed' ? record.item : null
      return isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string'
        ? `${item.text}\n`
        : ''
    })
    .join('')
}

const USAGE_LIMIT =
  /usage limit|rate limit|quota|too many requests|\b429\b|credits? (exhausted|remaining)|out of credits/i
const SIGNED_OUT =
  /not logged in|not signed in|log ?in again|sign ?in again|please (log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (failed|required)|invalid api key|token (expired|revoked)/i

/** Why a run that saved no image failed, from everything it printed. */
export function classifyAvatarAgentFailure(output: string): AvatarGenerationFailure {
  if (USAGE_LIMIT.test(output)) {
    return 'usage-limit'
  }
  if (SIGNED_OUT.test(output)) {
    return 'signed-out'
  }
  return 'failed'
}
