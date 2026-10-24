import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRowAttribution
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTextCuts } from './agent-session-text-encoding'

export type AgentSessionDeltaSnapshot = {
  text: string
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaSource = {
  live?: {
    key: string
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: AgentJournalRowAttribution & { observedAt?: number }
  }
  revision?: number
  epoch?: string
  itemId?: string
  cuts?: AgentSessionTextCuts
  lastCodeUnit?: number
  length: number
  bytes: number
  encodedBytes: number
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaWindow = {
  applied?: (source: AgentSessionDeltaSource) => void
  cuts?: AgentSessionTextCuts
  source?: AgentSessionDeltaSource
  limit?: number
  bytes: number
  encodedBytes: number
  length: number
  hasText: boolean
  baseLength: number
  suffix: string
  text: () => string
  replace?: true
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaCoalescerDeps = {
  /** Called with the FULL text accumulated for the key, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  source?: (key: string) => AgentSessionDeltaSource | undefined
  emitDelta?: (key: string, window: AgentSessionDeltaWindow) => unknown
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  /** Maximum distinct item streams retained at once. */
  maxStreams?: number
  /** The caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  /** Injected by tests so a window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  /** Returns false when a full stream cannot be flushed to admit this new key. */
  append: (key: string, delta: string) => boolean
  /** Emit one stream now, if it has unflushed text. */
  flush: (key: string) => boolean
  /** Emit every stream now. The lifecycle bypass. */
  flushAll: () => boolean
  /** Drop a stream without emitting — its authoritative body arrived, so the
   *  accumulated text is now the stale copy. */
  forget: (key: string) => void
  dispose: () => void
  /** Bounded last-known state for terminalizing a rejected completion. */
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  /** Streams with text not yet emitted, in arrival order, for a caller that writes them itself. */
  dirty: () => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** The caller wrote this stream's current text itself; nothing is owed until it grows. */
  markFlushed: (key: string) => void
  window: (key: string) => AgentSessionDeltaWindow | null
  dirtyWindows: () => { key: string; window: AgentSessionDeltaWindow }[]
}

export type AgentSessionDeltaStream = {
  source?: AgentSessionDeltaSource
  limit?: number
  encodedBytes: number
  chunks: string[]
  retainedBytes: number
  residentBytes: number
  uncreditedBytes: number
  cuts: AgentSessionTextCuts
  lastCodeUnit: number
  textLength: number
  observedBytes: number
  truncated: boolean
  dirty: boolean
  admittedLength: number
  pending: string[]
  hasText: boolean
}
