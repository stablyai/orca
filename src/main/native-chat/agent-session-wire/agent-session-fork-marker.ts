import { acpAgentName } from '../../acp/acp-structured-agent-definitions'
import { AGENT_SESSION_FORKED_FROM_PRESENTATION } from '../../../shared/agent-session/agent-session-fork'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import type { HistoryReader } from './agent-session-history-page-bounds'

export type ForkMarker = { forkedFrom: AgentSessionForkedFrom; sourceName: string }
export const FORK_MARKER_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'forked-from'
})

export function readForkMarker(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): ForkMarker | undefined {
  const forkedFrom = store.getRecord(sessionId)?.forkedFrom
  if (!forkedFrom) {
    return undefined
  }
  const source = store.getRecord(forkedFrom.sessionId)
  return {
    forkedFrom,
    sourceName: source
      ? source.conversationName?.trim() || acpAgentName(source.provider)
      : 'another chat'
  }
}

const projections = new WeakMap<
  readonly AgentJournalRenderItem[],
  { parent: AgentSessionForkedFrom; name: string; items: AgentJournalRenderItem[] }
>()

/** Presentation only: internal rewind/input readers never observe the synthetic row. */
export function projectForkMarker(
  snapshot: AgentJournalSnapshot,
  marker: ForkMarker | undefined
): AgentJournalSnapshot {
  if (!marker) {
    return snapshot
  }
  const cached = projections.get(snapshot.items)
  if (cached?.parent === marker.forkedFrom && cached.name === marker.sourceName) {
    return { ...snapshot, items: cached.items }
  }
  const boundary = marker.forkedFrom.childBoundary
  const anchor =
    boundary.kind === 'item'
      ? snapshot.items.find((item) => item.itemId === boundary.itemId)
      : undefined
  if (boundary.kind === 'item' && !anchor) {
    return snapshot
  }
  const sequence = anchor?.sequence ?? 0
  const index = anchor?.sequenceIndex ?? 0
  const item: AgentJournalRenderItem = {
    itemId: FORK_MARKER_ITEM_ID,
    sequence,
    sequenceIndex: 2 * index + 1,
    revision: 0,
    observedAt: anchor?.observedAt ?? 0,
    body: {
      kind: 'status',
      presentation: AGENT_SESSION_FORKED_FROM_PRESENTATION,
      text: `Forked from ${marker.sourceName}`,
      forkedFrom: { sessionId: marker.forkedFrom.sessionId }
    }
  }
  const items = snapshot.items.map((row) =>
    row.sequence === sequence ? { ...row, sequenceIndex: 2 * (row.sequenceIndex ?? 0) } : row
  )
  const after = anchor ? items.findIndex((row) => row.itemId === anchor.itemId) + 1 : 0
  items.splice(after, 0, item)
  projections.set(snapshot.items, { parent: marker.forkedFrom, name: marker.sourceName, items })
  return { ...snapshot, items }
}

export function withForkMarker(
  reader: HistoryReader = CLIENT_HISTORY_READER,
  read?: () => ForkMarker | undefined
): HistoryReader {
  return {
    ...reader,
    snapshot: (journal, snapshot, touched) => {
      const base =
        reader.snapshot?.(journal, snapshot, touched) ?? snapshot ?? journal.currentRead()
      return projectForkMarker(base, read?.())
    }
  }
}

export function forkHistoryReader(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): HistoryReader {
  return withForkMarker(undefined, () => readForkMarker(store, sessionId))
}
