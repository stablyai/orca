import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'

export function digestRequest(body: AgentJournalMessageItem): string {
  return digestStructuredValue(body)
}

export function digestStructuredValue(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
