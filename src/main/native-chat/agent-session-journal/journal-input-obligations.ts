import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalSubmission,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { readCodexErrorWillRetry } from '../../codex/codex-structured-thread-facts'
import type { JournalReducerState } from './journal-reducer'
import type {
  JournalRow,
  JournalSubmissionRow,
  JournalDispatchRow,
  JournalItemRow,
  JournalTombstoneRow
} from './journal-row-schema'
import type { JournalRecoveryWork } from './journal-unconfirmed-recovery'

export function createJournalInputObligations() {
  return {
    sources: new Map<string, JournalSubmissionRow>(),
    handovers: new Map<string, JournalDispatchRow>(),
    echoes: new Set<string>(),
    candidates: new Map<string, AgentJournalSubmission>(),
    ends: new Map<string, JournalItemRow | JournalTombstoneRow>(),
    ended: new Map<string, JournalItemRow | JournalTombstoneRow>(),
    revision: 0
  }
}

/** Reconstructed source ownership is independent of the replaceable render timeline. */
export function foldJournalInputObligations(
  state: JournalReducerState,
  row: JournalRow,
  dispatchApplies = true
): void {
  const input = state.inputs
  if (row.kind === 'submission') {
    input.sources.set(row.clientMessageId, row)
  }
  if (row.kind === 'dispatch' && !dispatchApplies) {
    return
  }
  if (row.kind === 'dispatch' && row.state === 'pending') {
    const target = input.handovers
    const source = input.sources.get(row.clientMessageId)
    const scope = source && state.derivedTurnScope.scopeFor(source.body)
    target.set(
      row.clientMessageId,
      row.state === 'pending' &&
        scope?.kind === 'turn' &&
        readAgentJournalTurn(state.items.get(scope.turnItemId)?.body)?.state === 'running' &&
        row.turnScope?.kind !== 'turn'
        ? { ...row, turnScope: scope }
        : row
    )
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    refreshJournalInputCandidate(state, row.clientMessageId)
  }
  if (row.kind === 'queue' && row.change.op === 'queued') {
    if (row.change.recovers) {
      input.candidates.delete(row.change.recovers)
      input.revision++
    }
    if (row.change.attempt) {
      refreshJournalInputCandidate(state, row.change.attempt)
    }
  }

  const items =
    row.kind === 'item'
      ? [row]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.flatMap((m) =>
            m.kind === 'item' ? [{ ...row, ...m, kind: 'item' as const }] : []
          )
        : []
  for (const item of items) {
    if (item.agentId || state.items.get(item.itemId)?.body !== item.body) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    const frame = item.body.kind === 'status' ? item.body.providerFrame : undefined
    if (turn) {
      input.ends.set(item.itemId, item)
    }
    if (
      (turn && turn.state !== 'running' && turn.state !== 'unverifiable') ||
      providerAttemptEnded(frame)
    ) {
      input.ends.set(item.itemId, item)
      const candidates = [...input.candidates.values()].filter(
        (send) =>
          (input.handovers.get(send.clientMessageId)?.fence ??
            input.sources.get(send.clientMessageId)?.fence ??
            send.fence) === (item.executionOwner ?? item.ownerFence ?? item.fence)
      )
      const latest = candidates.reduce(
        (last, send) =>
          Math.max(
            last,
            input.handovers.get(send.clientMessageId)?.seq ?? send.submittedSequence ?? 0
          ),
        0
      )
      for (const send of candidates) {
        const handover = input.handovers.get(send.clientMessageId)
        const source = input.sources.get(send.clientMessageId)
        const after =
          handover?.seq ?? (send.handoverRecorded ? Infinity : (source?.seq ?? Infinity))
        const scope = handover?.turnScope ?? source?.turnScope
        const target = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : item.itemId
        const user = turn?.userItemId
        const matches =
          scope?.kind === 'turn'
            ? scope.turnItemId === target
            : user
              ? user === agentJournalSubmissionKey(send.clientMessageId)
              : after === latest
        if (matches && item.seq > after && !input.ended.has(send.clientMessageId)) {
          input.ended.set(send.clientMessageId, item)
          input.revision++
        }
      }
    }
  }
  if (row.kind === 'tombstone' && row.stopEvent) {
    const previous = input.ends.get(row.itemId)
    if (
      previous?.kind === 'tombstone' &&
      JSON.stringify(previous.stopEvent) === JSON.stringify(row.stopEvent)
    ) {
      return
    }
    input.ends.set(row.itemId, row)
    for (const send of input.candidates.values()) {
      const handover = input.handovers.get(send.clientMessageId)
      const scope = handover?.turnScope
      const end = scope?.kind === 'turn' ? input.ends.get(scope.turnItemId) : undefined
      const turn = readAgentJournalTurn(
        end?.kind === 'item'
          ? end.body
          : scope?.kind === 'turn'
            ? state.items.get(scope.turnItemId)?.body
            : undefined
      )
      if (
        handover &&
        handover.fence === row.fence &&
        row.seq > handover.seq &&
        row.stopEvent.reason === 'user-stop' &&
        (!row.stopEvent.turnId || turn?.turnId === row.stopEvent.turnId) &&
        !input.ended.has(send.clientMessageId)
      ) {
        input.ended.set(send.clientMessageId, row)
      }
    }
    input.revision++
  }
}

function providerAttemptEnded(frame: AgentJournalStatusItem['providerFrame']): boolean {
  if (
    frame?.provider !== 'codex' ||
    frame.kind !== 'notification:error' ||
    frame.payload.truncated
  ) {
    return false
  }
  try {
    return !readCodexErrorWillRetry(JSON.parse(frame.payload.head))
  } catch {
    return false
  }
}

/** End of this execution attempt is an observation, never evidence of delivery. */
export function journalInputAttemptEnded(
  state: JournalReducerState,
  send: AgentJournalSubmission,
  work: JournalRecoveryWork | null
): boolean {
  const original = {
    ...send,
    fence:
      state.inputs.handovers.get(send.clientMessageId)?.fence ??
      state.inputs.sources.get(send.clientMessageId)?.fence ??
      send.fence
  }
  if (!work?.allowsRecovery() || work.owesSend(original)) {
    return false
  }
  if (work.generationEnded(original) || (send.dispatchState === 'unknown' && send.recovered)) {
    return true
  }
  return state.inputs.ended.has(send.clientMessageId)
}

export function refreshJournalInputCandidate(state: JournalReducerState, id: string): void {
  const send = state.submissions.get(id)
  if (send && (send.dispatchState === 'pending' || send.dispatchState === 'unknown')) {
    state.inputs.candidates.set(id, send)
  } else {
    state.inputs.candidates.delete(id)
  }
  state.inputs.revision++
}
