import { journalItemsAtSequence, journalItemsById } from './agent-session-journal-item-index'
import { compareAgentJournalItems } from '../../../../../shared/agent-session/journal/agent-session-journal-position'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { defaultAgentChatLabel } from '../../../../../shared/agent-session/agent-session-chat-label'
import { AGENT_SESSION_FORKED_FROM_PRESENTATION } from '../../../../../shared/agent-session/agent-session-fork'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionForkedFrom } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
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
      ? source.conversationName?.trim() || defaultAgentChatLabel(source.provider)
      : 'another chat'
  }
}

type MarkerPosition = { sequence: number; index: number; observedAt: number }
type MarkerReader = () => ForkMarker | undefined

// Retain the former group for delayed readers until an epoch change discards it.
type ProjectedPosition = { epoch: string; sequence?: number; restored?: number }
const projectedPositions = new WeakMap<AgentSessionJournal, ProjectedPosition>()
const projections = new WeakMap<
  readonly AgentJournalRenderItem[],
  { parent: AgentSessionForkedFrom; name: string; items: AgentJournalRenderItem[] }
>()

function markerPosition(
  snapshot: AgentJournalSnapshot,
  marker: ForkMarker
): MarkerPosition | undefined {
  const boundary = marker.forkedFrom.childBoundary
  const anchor =
    boundary.kind === 'item' ? journalItemsById(snapshot.items).get(boundary.itemId) : undefined
  if (boundary.kind === 'item' && !anchor) {
    return undefined
  }
  return {
    sequence: anchor?.sequence ?? 0,
    index: anchor?.sequenceIndex ?? 0,
    observedAt: anchor?.observedAt ?? 0
  }
}

/** The same group supplies cold pages, touched-row delivery and idle name refreshes. */
function deriveForkMarkerGroup(
  snapshot: AgentJournalSnapshot,
  marker: ForkMarker
): AgentJournalRenderItem[] {
  const position = markerPosition(snapshot, marker)
  if (!position) {
    return []
  }
  const group = journalItemsAtSequence(snapshot.items, position.sequence).map((row) => ({
    ...row,
    sequenceIndex: 2 * (row.sequenceIndex ?? 0)
  }))
  group.push({
    itemId: FORK_MARKER_ITEM_ID,
    sequence: position.sequence,
    sequenceIndex: 2 * position.index + 1,
    revision: 0,
    observedAt: position.observedAt,
    body: {
      kind: 'status',
      presentation: AGENT_SESSION_FORKED_FROM_PRESENTATION,
      text: `Forked from ${marker.sourceName}`,
      forkedFrom: { sessionId: marker.forkedFrom.sessionId }
    }
  })
  return group.sort(compareAgentJournalItems)
}

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
  const group = deriveForkMarkerGroup(snapshot, marker)
  if (!group.length) {
    return snapshot
  }
  const replacements = new Map(group.map((row) => [row.itemId, row]))
  const items = snapshot.items.map((row) => replacements.get(row.itemId) ?? row)
  const boundary = marker.forkedFrom.childBoundary
  const after =
    boundary.kind === 'item' ? items.findIndex((row) => row.itemId === boundary.itemId) + 1 : 0
  items.splice(after, 0, replacements.get(FORK_MARKER_ITEM_ID)!)
  projections.set(snapshot.items, { parent: marker.forkedFrom, name: marker.sourceName, items })
  return { ...snapshot, items }
}

export function withForkMarker(
  reader: HistoryReader = CLIENT_HISTORY_READER,
  read?: MarkerReader
): HistoryReader {
  return {
    ...reader,
    snapshot: (journal, snapshot, touched) => {
      const marker = read?.()
      if (!marker) {
        return reader.snapshot?.(journal, snapshot, touched) ?? snapshot ?? journal.currentRead()
      }
      const raw = snapshot ?? journal.itemsRead()
      const position = markerPosition(raw, marker)
      const previous = projectedPositions.get(journal)
      const sameEpoch = previous?.epoch === raw.cursor.epoch
      const moved = sameEpoch && previous.sequence !== position?.sequence
      const oldSequence = sameEpoch
        ? moved
          ? (previous.sequence ?? previous.restored)
          : previous.restored
        : undefined
      projectedPositions.set(journal, {
        epoch: raw.cursor.epoch,
        sequence: position?.sequence,
        restored: oldSequence
      })
      if (!touched) {
        return projectForkMarker(reader.snapshot?.(journal, raw) ?? raw, marker)
      }
      const live = journalItemsById(raw.items)
      const boundary = marker.forkedFrom.childBoundary
      const affected =
        (moved && oldSequence !== undefined) ||
        touched.has(FORK_MARKER_ITEM_ID) ||
        (boundary.kind === 'item' && touched.has(boundary.itemId)) ||
        (position && [...touched].some((id) => live.get(id)?.sequence === position.sequence))
      if (affected) {
        touched.add(FORK_MARKER_ITEM_ID)
        for (const sequence of new Set([position?.sequence, oldSequence])) {
          if (sequence !== undefined) {
            for (const row of journalItemsAtSequence(raw.items, sequence)) {
              touched.add(row.itemId)
            }
          }
        }
      }
      const selected = {
        ...raw,
        items: [...touched].flatMap((id) => live.get(id) ?? []).sort(compareAgentJournalItems)
      }
      const base = reader.snapshot?.(journal, selected, touched) ?? selected
      return affected ? projectForkMarker(base, marker) : base
    }
  }
}

export function forkHistoryReader(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): HistoryReader {
  return withForkMarker(undefined, () => readForkMarker(store, sessionId))
}
