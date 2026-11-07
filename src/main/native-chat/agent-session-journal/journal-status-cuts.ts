import { agentTurnVerdict } from '../../../shared/agent-status/lifecycle/agent-turn-outcome'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { commandTurnsByBody } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import {
  nativeChatUsageLimitOfRow,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  orcaStopCauseOfRow,
  type NativeChatOrcaStopCut
} from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatusItem } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

/** Merge only the two request-boundary families; command exclusions use current point lookups. */
function latestCutTurn(state: JournalReducerState, floor: number) {
  if (
    journalInputOrder(state)
      .statusInputs(state, [])
      .some(
        (input) =>
          input.dispatchState === 'pending' && (!floor || (input.acceptedSequence ?? 0) > floor)
      )
  ) {
    return null
  }
  const turns = state.queries
    .statusItems(state, { kind: 'turns', root: true, floor })
    [Symbol.iterator]()
  const users = state.queries.statusItems(state, { kind: 'users', floor })[Symbol.iterator]()
  let turn = turns.next().value
  let user = users.next().value
  const commands = commandTurnsByBody((id) => {
    const item = renderJournalStatusItem(state, id)
    return item && (!floor || item.sequence > floor) ? item.body : null
  })
  while (turn || user) {
    const useTurn =
      turn && (!user || compareJournalStatusPositions(turn.position, user.position) >= 0)
    const candidate: JournalStatusItem = useTurn ? turn! : user!
    const item = candidate.item
    if (!isStructuredAgentSessionNonRequestRow(item, commands)) {
      if (item.body.kind === 'message' && item.body.role === 'user') {
        return null
      }
      const lifecycle = readAgentJournalTurn(item.body)
      if (lifecycle) {
        return {
          item,
          lifecycle,
          verdict: agentTurnVerdict({
            state: lifecycle.state,
            outcome: readAgentJournalTurnOutcome(lifecycle)
          })
        }
      }
    }
    if (useTurn) {
      turn = turns.next().value
    } else {
      user = users.next().value
    }
  }
  return null
}

export function readJournalUsageLimitCut(
  state: JournalReducerState,
  floor = 0
): NativeChatUsageLimitCut | null {
  const latest = latestCutTurn(state, floor)
  if (!latest || latest.verdict !== 'failure') {
    return null
  }
  for (const { item } of state.queries.statusItems(state, {
    kind: 'scoped-statuses',
    turnItemId: latest.item.itemId,
    floor
  })) {
    const displayed = renderJournalStatusItem(state, item.itemId)
    const limit = displayed && nativeChatUsageLimitOfRow(displayed)
    if (limit) {
      return {
        turnItemId: latest.item.itemId,
        ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
        turnEndedAt: latest.item.recoveredAt ?? latest.lifecycle.completedAt
      }
    }
  }
  return null
}

export function readJournalUsageLimitContinueIdentity(
  state: JournalReducerState
): UsageLimitContinueIdentity | undefined {
  const cut = readJournalUsageLimitCut(state)
  return cut?.resetsAt !== undefined && Number.isFinite(cut.resetsAt)
    ? { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt }
    : undefined
}

export function readJournalOrcaStopCut(
  state: JournalReducerState,
  floor = 0
): NativeChatOrcaStopCut | null {
  const latest = latestCutTurn(state, floor)
  if (!latest || latest.verdict !== 'interruption') {
    return null
  }
  for (const { item } of state.queries.statusItems(state, {
    kind: 'scoped-statuses',
    turnItemId: latest.item.itemId,
    floor
  })) {
    const displayed = renderJournalStatusItem(state, item.itemId)
    const cause = displayed && orcaStopCauseOfRow(displayed)
    if (cause) {
      return { turnItemId: latest.item.itemId, cause }
    }
  }
  return null
}
