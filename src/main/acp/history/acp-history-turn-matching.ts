import { OrderedAvailability } from './acp-history-ordered-availability'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isHistoricalProviderTimelineItem } from '../../native-chat/agent-session-timeline/provider-timeline-history'
import type { AcpHistoryItem } from './acp-history-journal-overlay'
import type { AcpIdentifiedHistoryTurn } from './acp-history-replay'
import type { AcpHistoryScope } from './acp-history-translation'
import {
  acpHistoryHasOutput,
  acpPromptDigest,
  type AcpNativeTurn
} from './acp-history-turn-content'

export type AcpHistoryCandidate = { source: AcpIdentifiedHistoryTurn; items: AcpHistoryItem[] }
export type AcpHistoryReadJournal = {
  /** Chat-sent turns in sequence order. */
  natives: readonly AcpNativeTurn[]
  /** Whether any row was adopted from the provider session. */
  adoptedAny: boolean
  /** Adopted rows a candidate names: record ID to sequence. */
  adopted: ReadonlyMap<string, number>
  /** Saved candidate turn rows and their openers. */
  item: (key: string) => AgentJournalRenderItem | null
  /** The turn a saved candidate row is placed in. */
  placement: (key: string) => { turnItemId: string | null } | null
}

/** The adopted record IDs that can stand for a replayed turn's messages. */
export function acpAdoptedRecordIds(messageIds: readonly string[]): string[] {
  return messageIds.flatMap((id) =>
    ['', 'opencode:'].flatMap((prefix) =>
      ['', ':reasoning', ':omission'].map((suffix) => `${prefix}${id}${suffix}`)
    )
  )
}

/** One source index supplies both exact coverage proof and the candidate bodies to reconcile. */
export function matchAcpHistoryTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal,
  candidates: readonly AcpHistoryCandidate[],
  importedAt: number | null,
  requests: ReadonlySet<string>,
  check: () => void,
  covered?: ReadonlySet<string>
) {
  const { natives, adopted } = journal
  const nativeIndex = new Map(natives.map((native, index) => [native.itemId, index]))
  if (scope.identity === 'prompt-id' && journal.adoptedAny && importedAt === null) {
    throw new Error('no-legacy-origin')
  }
  const kind = new Map<string, 'native' | 'imported' | 'adopted'>()
  const matched = new Map<string, number>()
  const boundaries = new Map<string, number>()
  for (const { source, items } of candidates) {
    check()
    if (covered?.has(source.turn)) {
      kind.set(source.turn, 'adopted')
      continue
    }
    const owners = new Set<number>()
    let heldTurn: AgentJournalRenderItem | undefined
    for (const candidate of items) {
      check()
      const ownKey = agentJournalItemKey(candidate.identity)
      if (candidate.body.kind === 'turn') {
        const held = journal.item(ownKey)
        heldTurn = held ?? undefined
        const native = held && nativeIndex.get(held.itemId)
        if (native !== undefined && native !== null) {
          owners.add(native)
        }
      } else if (acpHistoryHasOutput(candidate.body)) {
        const native = nativeIndex.get(journal.placement(ownKey)?.turnItemId ?? '')
        if (native !== undefined) {
          owners.add(native)
        }
      }
    }
    const native = [...owners][0]
    const historical =
      heldTurn && isHistoricalProviderTimelineItem(heldTurn, journal.item) ? heldTurn : undefined
    if (owners.size > 1 || (historical && native !== undefined)) {
      throw new Error('conflicting-history-owners')
    }
    if (native !== undefined || (scope.identity === 'prompt-id' && requests.has(source.turn))) {
      kind.set(source.turn, 'native')
      if (native !== undefined) {
        matched.set(source.turn, native)
      }
    } else if (historical) {
      kind.set(source.turn, 'imported')
      boundaries.set(source.turn, historical.sequence)
    } else if (heldTurn) {
      throw new Error('unowned-history-turn')
    } else {
      const adoptedSequence = acpAdoptedRecordIds(source.messageIds).flatMap((recordId) => {
        const sequence = adopted.get(recordId)
        return sequence === undefined ? [] : [sequence]
      })
      if (
        adoptedSequence.length ||
        (scope.identity === 'prompt-id' &&
          importedAt !== null &&
          source.startedAt !== null &&
          source.startedAt <= importedAt)
      ) {
        kind.set(source.turn, 'adopted')
        if (scope.identity === 'user-message-id') {
          let sequence = -Infinity
          for (const value of adoptedSequence) {
            check()
            sequence = Math.max(sequence, value)
          }
          boundaries.set(source.turn, sequence)
        }
      }
    }
  }
  if (scope.identity === 'user-message-id') {
    const used = new Set(matched.values())
    for (const [id, sequence] of boundaries) {
      let low = 0
      let high = natives.length
      while (low < high) {
        check()
        const middle = Math.floor((low + high) / 2)
        if (natives[middle].sequence < sequence) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      boundaries.set(id, low)
    }
    const occurrences = new Map<string, number[]>()
    const byText = new Map<string, number[]>()
    const positions: number[] = []
    for (const [index, { source }] of candidates.entries()) {
      check()
      const held = occurrences.get(source.turn) ?? []
      held.push(index)
      occurrences.set(source.turn, held)
      positions.push(index)
    }
    const anchors = new OrderedAvailability(positions, check, false)
    for (const [index, { source }] of candidates.entries()) {
      check()
      if (matched.has(source.turn) || boundaries.has(source.turn)) {
        anchors.set(index, true)
      }
    }
    for (const [index, native] of natives.entries()) {
      check()
      if (!native.output && native.text !== null && !used.has(index)) {
        const ranks = byText.get(native.text) ?? []
        ranks.push(index)
        byText.set(native.text, ranks)
      }
    }
    const available = new Map<string, OrderedAvailability>()
    for (const [text, ranks] of byText) {
      check()
      available.set(text, new OrderedAvailability(ranks, check))
    }
    let floor = -1
    for (const [index, candidate] of candidates.entries()) {
      check()
      const id = candidate.source.turn
      const exact = matched.get(id)
      const edge = boundaries.get(id)
      if (exact !== undefined) {
        floor = exact
        continue
      }
      if (edge !== undefined) {
        floor = edge - 1
        continue
      }
      if (kind.has(id) || candidate.items.some((item) => acpHistoryHasOutput(item.body))) {
        continue
      }
      const text = candidate.source.textOnly ? acpPromptDigest(candidate.source.user.blocks) : null
      if (text === null) {
        continue
      }
      const nextAnchor = anchors.after(index)
      const nextId = nextAnchor && candidates[nextAnchor.value]?.source.turn
      const ceiling =
        nextId === undefined
          ? natives.length
          : (matched.get(nextId) ?? boundaries.get(nextId) ?? natives.length)
      const group = available.get(text)
      const next = group?.after(floor)
      if (next && next.value < ceiling) {
        kind.set(id, 'native')
        matched.set(id, next.value)
        used.add(next.value)
        floor = next.value
        group?.set(next.index, false)
        for (const position of occurrences.get(id) ?? []) {
          check()
          if (position > index) {
            anchors.set(position, true)
          }
        }
      }
    }
  }
  return { natives, kind, matched }
}
