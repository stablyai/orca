import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemSubagentId,
  agentJournalLinkageFields
} from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { HistoricalJournalItemRevision } from './journal-historical-item-revisions'

type Revision = HistoricalJournalItemRevision

/** Exact cleanup identities prove runtime loss; a later cleanup cannot explain an earlier withdrawal. */
export function lostJournalRevision(sessionId: string, revision: Revision): boolean {
  const { item } = revision
  const owner = revision.executionOwner ?? revision.ownerFence
  if (!item || owner === undefined) {
    return false
  }
  return revision.settlementIds.some((saved) => {
    const partition = /:(\d+)\/(\d+)$/.exec(saved)
    if (partition && (+partition[1] < 1 || +partition[1] > +partition[2])) {
      return false
    }
    const id = partition ? saved.slice(0, partition.index) : saved
    const exit = [
      `provider-exit:${sessionId}:${owner}:`,
      `dead-generation:expected-close:${sessionId}:${owner}:`,
      `dead-generation:provider-exit:${sessionId}:${owner}:`
    ].find((prefix) => id.startsWith(prefix) && id.length > prefix.length)
    if (exit) {
      return exit.startsWith('provider-exit:') || item.recovered === true
    }
    if (!item.recovered) {
      return false
    }
    const timeline = `provider-timeline:${sessionId}:`
    if (id.startsWith(timeline) && /^.+:\d+:session-end$/.test(id.slice(timeline.length))) {
      return true
    }
    const stale = `stale-session:${sessionId}:`
    const rest = id.startsWith(stale) ? /^(\d+):(.+)$/.exec(id.slice(stale.length)) : null
    return rest !== null && +rest[1] >= owner
  })
}

function sameRequest(left: AgentJournalRenderItem, right: AgentJournalRenderItem): boolean {
  return (
    left.itemId === right.itemId &&
    isDeepStrictEqual(left.turnScope, right.turnScope) &&
    isDeepStrictEqual(agentJournalLinkageFields(left), agentJournalLinkageFields(right)) &&
    isDeepStrictEqual({ ...left.body, resolution: null }, { ...right.body, resolution: null })
  )
}

/** Each parent is classified once; requests query its opening state and whole-tip suffix. */
export function journalLostParentTurns(
  sessionId: string,
  history: ReadonlyMap<string, readonly Revision[]>
): (itemId: string, sequence: number) => ReturnType<typeof readAgentJournalTurn> {
  const summaries = new Map<
    string,
    {
      positions: { sequence: number; running: boolean }[]
      turn: ReturnType<typeof readAgentJournalTurn>
      latestBad: number | undefined
    }
  >()
  return (itemId, sequence) => {
    let summary = summaries.get(itemId)
    if (!summary) {
      summary = { positions: [], turn: null, latestBad: undefined }
      for (const revision of history.get(itemId) ?? []) {
        const turn = readAgentJournalTurn(revision.item?.body)
        const running = turn?.state === 'running'
        summary.positions.push({ sequence: revision.sequence, running })
        summary.turn = turn
        if (
          !turn ||
          (!running && (turn.state !== 'interrupted' || !lostJournalRevision(sessionId, revision)))
        ) {
          summary.latestBad = revision.sequence
        }
      }
      summaries.set(itemId, summary)
    }
    let low = 0
    let high = summary.positions.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (summary.positions[middle]!.sequence <= sequence) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return summary.positions[low - 1]?.running &&
      (summary.latestBad === undefined || summary.latestBad < sequence)
      ? summary.turn
      : null
  }
}

/** Returns the original pending request only when its entire subsequent lifetime is known. */
export function provenLostJournalRequest(input: {
  sessionId: string
  current: AgentJournalRenderItem
  history: ReadonlyMap<string, readonly Revision[]>
  parentTurn: ReturnType<typeof journalLostParentTurns>
  answers: ReadonlyMap<string | null, number>
  contextFloor: number
  personAcceptedSequence: number
  removedTurnIds: ReadonlySet<string>
  personallyStopped: (item: AgentJournalRenderItem, turnId: string) => boolean
}): Revision | null {
  const { current, history, sessionId } = input
  const revisions = history.get(current.itemId)
  const first = revisions?.find((revision) => {
    const body = revision.item?.body
    return (
      (body?.kind === 'question' || body?.kind === 'approval') &&
      body.resolution.state === 'pending'
    )
  })
  const original = first?.item
  const turnItemId = original?.turnScope?.kind === 'turn' ? original.turnScope.turnItemId : null
  if (
    !first ||
    !original ||
    !turnItemId ||
    original.sequence <= input.contextFloor ||
    original.sequence < input.personAcceptedSequence ||
    !sameRequest(original, current)
  ) {
    return null
  }
  const owner = first.executionOwner ?? first.ownerFence
  const turn = input.parentTurn(turnItemId, first.sequence)
  if (
    owner === undefined ||
    !turn ||
    input.removedTurnIds.has(turn.turnId) ||
    input.personallyStopped(original, turn.turnId)
  ) {
    return null
  }
  let loss = 0
  for (const revision of revisions ?? []) {
    if (revision.sequence < first.sequence) {
      continue
    }
    const item = revision.item
    if (
      !item ||
      !sameRequest(original, item) ||
      (revision.executionOwner ?? revision.ownerFence) !== owner ||
      (item.body.kind !== 'question' && item.body.kind !== 'approval')
    ) {
      return null
    }
    if (item.body.resolution.state === 'cancelled' && lostJournalRevision(sessionId, revision)) {
      loss = revision.sequence
    } else if (item.body.resolution.state !== 'pending') {
      return null
    }
  }
  if (!loss || revisions?.at(-1)?.item?.revision !== current.revision) {
    return null
  }
  // A resolved row without attributable acceptance is unknown too; this only limits old cancellation repair.
  if ((input.answers.get(agentJournalItemSubagentId(original)) ?? 0) > first.sequence) {
    return null
  }
  return first
}
