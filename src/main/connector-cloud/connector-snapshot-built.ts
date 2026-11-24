// The built-snapshot span's counts: what each traced entry sent or why it was left out, never its text.
import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'

type Snapshot = Extract<ConnectorEvent, { kind: 'snapshot' }>

export type ConnectorSnapshotWire = {
  snapshot: Snapshot
  inWindow: number
  omitted: { paneKey: string; reason: 'count' | 'bytes' }[]
  downgraded: ReadonlySet<string>
}

// Per-entry detail stays small at any link count; aggregates cover the rest.
const MAX_TRACED_ENTRIES = 50

type EntryDisposition =
  | 'sent'
  | 'downgraded'
  | 'restated'
  | 'omitted-count'
  | 'omitted-bytes'
  | 'none'

export function builtCounts(event: ConversationSnapshot, wire: ConnectorSnapshotWire) {
  const omitted = new Map(wire.omitted.map((entry) => [entry.paneKey, entry.reason]))
  const sent = new Set(wire.snapshot.conversations.map((entry) => entry.paneKey))
  const traced = event.conversations.filter(
    (entry) => entry.working || entry.prompt || entry.turnId !== null || entry.trace?.promptId
  )
  const disposition = (entry: (typeof traced)[number]): EntryDisposition => {
    const cut = omitted.get(entry.paneKey)
    if (cut) {
      return cut === 'count' ? 'omitted-count' : 'omitted-bytes'
    }
    if (!entry.prompt || !sent.has(entry.paneKey)) {
      return 'none'
    }
    if (wire.downgraded.has(entry.paneKey)) {
      return 'downgraded'
    }
    return entry.trace?.prompt === 'restated' ? 'restated' : 'sent'
  }
  return {
    linked: event.conversations.length,
    inWindow: wire.inWindow,
    sent: wire.snapshot.conversations.length,
    omittedByCount: wire.omitted.filter((entry) => entry.reason === 'count').length,
    omittedByBytes: wire.omitted.filter((entry) => entry.reason === 'bytes').length,
    promptsDowngraded: wire.downgraded.size,
    restated: event.conversations.filter(
      (entry) => entry.trace?.prompt === 'restated' && sent.has(entry.paneKey)
    ).length,
    entriesTraced: Math.min(traced.length, MAX_TRACED_ENTRIES),
    entriesNotTraced: Math.max(0, traced.length - MAX_TRACED_ENTRIES),
    entries: traced.slice(0, MAX_TRACED_ENTRIES).map((entry) => ({
      sessionId: entry.trace?.sessionId ?? null,
      paneKey: entry.paneKey,
      heard: entry.trace?.heard ?? 'none',
      prompt: disposition(entry),
      promptId: entry.prompt?.promptId ?? entry.trace?.promptId ?? null,
      standing: entry.trace?.standing ?? 'n/a',
      working: entry.working,
      turnId: entry.turnId !== null
    }))
  }
}
