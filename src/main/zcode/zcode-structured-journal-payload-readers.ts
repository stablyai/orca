// Field readers for ZCode app-server payloads the journal translator consumes.
// The wire is schema-validated upstream; these read fields defensively, so a
// newer server adding fields degrades to an ignored row, not a dropped frame.

import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'

export function agentKey(identity: AgentJournalItemIdentity): string {
  return agentJournalItemKey(identity)
}

export function readString(record: unknown, key: string): string | undefined {
  const value = isRecord(record) ? record[key] : undefined
  return typeof value === 'string' ? value : undefined
}

export function readRecord(record: unknown, key: string): Record<string, unknown> | undefined {
  const value = isRecord(record) ? record[key] : undefined
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tool item's state word, in the journal's vocabulary. */
export function zcodeToolState(stateName: string | undefined): 'completed' | 'failed' | 'running' {
  return stateName === 'completed' ? 'completed' : stateName === 'error' ? 'failed' : 'running'
}

/** The tool's finished output: stdout or the error word, capped at the journal's byte budget. */
export function zcodeToolOutput(state: Record<string, unknown>): {
  head: string
  byteLength: number
  digest: string
  truncated: boolean
} {
  const raw = readString(state, 'output') ?? readString(state, 'error') ?? ''
  return {
    head: raw.slice(0, 65_536),
    byteLength: Buffer.byteLength(raw, 'utf8'),
    digest: '',
    truncated: raw.length > 65_536
  }
}
