import { OrderedAvailability } from './acp-history-ordered-availability'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import type { AcpHistoryItem } from './acp-history-journal-overlay'
import type { AcpIdentifiedHistoryTurn } from './acp-history-replay'
import type { AcpHistoryScope } from './acp-history-translation'

export type AcpHistoryCandidate = { source: AcpIdentifiedHistoryTurn; items: AcpHistoryItem[] }
export type AcpHistoryReadJournal = {
  items: ReadonlyMap<string, AgentJournalRenderItem>
}
type NativeTurn = { itemId: string; sequence: number; text: string | null; output: boolean }

export function acpHistoryHasOutput(body: AgentJournalItemBody): boolean {
  return (
    body.kind !== 'turn' &&
    !(body.kind === 'message' && body.role === 'user') &&
    (body.kind !== 'message' ||
      body.blocks.some((block) => block.type !== 'text' || block.text.length > 0))
  )
}

export function acpNativeTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal
): NativeTurn[] {
  const turns: NativeTurn[] = []
  for (const item of journal.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    const identity = parseAgentJournalItemKey(item.itemId)
    if (
      turn?.userItemId &&
      parseAgentJournalItemKey(turn.userItemId)?.provider === 'orca' &&
      identity?.provider === 'legacy' &&
      identity.agent === scope.agent &&
      identity.sessionId === scope.sessionId &&
      identity.recordId === `turn-lifecycle:${turn.turnId}` &&
      isProviderTimelineTurnInNamespace(turn.turnId, scope.providerSessionId)
    ) {
      const user = journal.items.get(turn.userItemId)?.body
      turns.push({
        itemId: item.itemId,
        sequence: item.sequence,
        output: false,
        text: user?.kind === 'message' && !user.command ? promptText(user.blocks) : null
      })
    }
  }
  const byId = new Map(turns.map((turn) => [turn.itemId, turn]))
  for (const item of journal.items.values()) {
    const owner = item.turnScope?.kind === 'turn' ? byId.get(item.turnScope.turnItemId) : undefined
    if (owner && acpHistoryHasOutput(item.body)) {
      owner.output = true
    }
  }
  return turns.toSorted((a, b) => a.sequence - b.sequence)
}

/** One source index supplies both exact coverage proof and the candidate bodies to reconcile. */
export function matchAcpHistoryTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal,
  candidates: readonly AcpHistoryCandidate[],
  importedAt: number | null,
  requests: ReadonlySet<string>,
  check: () => void
) {
  const natives = acpNativeTurns(scope, journal)
  const nativeIndex = new Map(natives.map((native, index) => [native.itemId, index]))
  const adopted = new Map<string, number>()
  for (const item of journal.items.values()) {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (
      identity?.provider === 'legacy' &&
      identity.agent === scope.agent &&
      identity.sessionId === scope.providerSessionId
    ) {
      adopted.set(identity.recordId, item.sequence)
    }
  }
  if (scope.identity === 'prompt-id' && adopted.size > 0 && importedAt === null) {
    throw new Error('no-legacy-origin')
  }
  const kind = new Map<string, 'native' | 'imported' | 'adopted'>()
  const matched = new Map<string, number>()
  const boundaries = new Map<string, number>()
  const read = (key: string) => journal.items.get(key) ?? null
  for (const { source, items } of candidates) {
    check()
    const owners = new Set<number>()
    let heldTurn: AgentJournalRenderItem | undefined
    for (const candidate of items) {
      check()
      const ownKey = agentJournalItemKey(candidate.identity)
      const held = read(ownKey)
      if (candidate.body.kind === 'turn') {
        heldTurn = held ?? undefined
        const native = held && nativeIndex.get(held.itemId)
        if (native !== undefined && native !== null) {
          owners.add(native)
        }
      } else if (acpHistoryHasOutput(candidate.body) && held?.turnScope?.kind === 'turn') {
        const native = nativeIndex.get(held.turnScope.turnItemId)
        if (native !== undefined) {
          owners.add(native)
        }
      }
    }
    const native = [...owners][0]
    const historical =
      heldTurn && isHistoricalProviderTimelineItem(heldTurn, read) ? heldTurn : undefined
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
      const adoptedSequence = source.messageIds.flatMap((id) =>
        ['', 'opencode:'].flatMap((prefix) =>
          ['', ':reasoning', ':omission'].flatMap((suffix) => {
            const sequence = adopted.get(`${prefix}${id}${suffix}`)
            return sequence === undefined ? [] : [sequence]
          })
        )
      )
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
      const text = candidate.source.textOnly ? promptText(candidate.source.user.blocks) : null
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

function promptText(blocks: readonly NativeChatBlock[]): string | null {
  return blocks.every((block) => block.type === 'text')
    ? blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    : null
}
