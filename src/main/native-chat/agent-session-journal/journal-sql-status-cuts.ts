import { agentTurnVerdict } from '../../../shared/agent-status/lifecycle/agent-turn-outcome'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { commandTurnsByBody } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { nativeChatUsageLimitOfRow } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  orcaStopCauseOfRow,
  type NativeChatOrcaStopCut
} from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  usageLimitContinueTag,
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  type HostUsageLimitCut
} from '../agent-session-wire/recovery/structured-agent-session-usage-limit-chain'

/** Merge only the two request-boundary families; command exclusions use current point lookups. */
function latestCutTurn(state: JournalSqlStatusContext, floor: number) {
  if (
    state
      .statusInputs()
      .some(
        (input) =>
          input.dispatchState === 'pending' && (!floor || (input.acceptedSequence ?? 0) > floor)
      )
  ) {
    return null
  }
  const turns = state.select({ kind: 'turns', root: true, floor })[Symbol.iterator]()
  const users = state.select({ kind: 'users', floor })[Symbol.iterator]()
  let turn = turns.next().value
  let user = users.next().value
  const commands = commandTurnsByBody((id) => {
    const item = state.displayed(id)
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

export function readJournalSqlUsageLimitCut(
  state: JournalSqlStatusContext,
  floor = 0
): HostUsageLimitCut | null {
  const latest = latestCutTurn(state, floor)
  if (!latest || latest.verdict !== 'failure') {
    return null
  }
  for (const { item } of state.select({
    kind: 'scoped-statuses',
    turnItemId: latest.item.itemId,
    floor
  })) {
    const displayed = state.displayed(item.itemId)
    const limit = displayed && nativeChatUsageLimitOfRow(displayed)
    if (limit) {
      const fence = state.itemFence(latest.item.itemId)
      return {
        turnItemId: latest.item.itemId,
        chain: readUsageLimitChain(state, latest.item.itemId),
        ...(fence === undefined ? {} : { fence }),
        ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
        turnEndedAt: latest.item.recoveredAt ?? latest.lifecycle.completedAt
      }
    }
  }
  return null
}

/** Follow only the automatic opener joins; unrelated requests end the chain. */
function readUsageLimitChain(state: JournalSqlStatusContext, turnItemId: string): number {
  let current = state.displayed(turnItemId)
  let chain = 0
  let inputBound = Infinity
  const commands = commandTurnsByBody((id) => state.displayed(id)?.body ?? null)
  while (current && chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT) {
    const userItemId = readAgentJournalTurn(current.body)?.userItemId
    if (!userItemId) {
      break
    }
    const alias = state.scope.db
      .prepare(`SELECT item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND provider_item_id=?`)
      .get(...state.scope.prefix, userItemId)
    const input = state.inputForItem(
      alias ? String(state.scope.examined(alias).item_id) : userItemId
    )
    const ordinal = input ? state.inputOrdinal(input.clientMessageId) : Infinity
    const tag =
      input?.origin === 'host'
        ? /^\d{13}-([0-9a-f]{16})[0-9a-f]{16}$/.exec(input.clientMessageId)?.[1]
        : undefined
    if (!input || !tag || ordinal >= inputBound) {
      break
    }
    const openerKeys = new Set([userItemId, agentJournalSubmissionKey(input.clientMessageId)])
    let currentPosition: JournalStatusItem['position'] | undefined
    for (const candidate of state.select({
      kind: 'turns',
      root: true,
      before: current.sequence + 1
    })) {
      if (candidate.item.itemId === current.itemId) {
        currentPosition = candidate.position
        break
      }
    }
    if (!currentPosition) {
      break
    }
    const turns = state
      .select({ kind: 'turns', root: true, before: current.sequence + 1 })
      [Symbol.iterator]()
    const users = state.select({ kind: 'users' })[Symbol.iterator]()
    let turn = turns.next().value
    let user = users.next().value
    let previous: JournalStatusItem | undefined
    while (turn || user) {
      const useTurn =
        turn && (!user || compareJournalStatusPositions(turn.position, user.position) >= 0)
      const candidate: JournalStatusItem = useTurn ? turn! : user!
      if (useTurn) {
        turn = turns.next().value
      } else {
        user = users.next().value
      }
      if (
        compareJournalStatusPositions(candidate.position, currentPosition) >= 0 ||
        openerKeys.has(candidate.item.itemId) ||
        isStructuredAgentSessionNonRequestRow(candidate.item, commands)
      ) {
        continue
      }
      if (readAgentJournalTurn(candidate.item.body)) {
        previous = candidate
      }
      break
    }
    if (!previous) {
      break
    }
    let limit: ReturnType<typeof nativeChatUsageLimitOfRow> = null
    for (const candidate of state.select({
      kind: 'scoped-statuses',
      turnItemId: previous.item.itemId
    })) {
      if (
        compareJournalStatusPositions(candidate.position, previous.position) > 0 &&
        compareJournalStatusPositions(candidate.position, currentPosition) < 0
      ) {
        limit = nativeChatUsageLimitOfRow(candidate.item)
        if (limit) {
          break
        }
      }
    }
    if (
      limit?.resetsAt === undefined ||
      usageLimitContinueTag({
        turnItemId: previous.item.itemId,
        resetsAt: limit.resetsAt
      }) !== tag
    ) {
      break
    }
    chain++
    current = previous.item
    inputBound = ordinal
  }
  return chain
}

export function readJournalSqlUsageLimitContinueIdentity(
  state: JournalSqlStatusContext
): UsageLimitContinueIdentity | undefined {
  const cut = readJournalSqlUsageLimitCut(state)
  return cut?.resetsAt !== undefined && Number.isFinite(cut.resetsAt)
    ? { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt }
    : undefined
}

export function readJournalSqlOrcaStopCut(
  state: JournalSqlStatusContext,
  floor = 0
): NativeChatOrcaStopCut | null {
  const latest = latestCutTurn(state, floor)
  if (!latest || latest.verdict !== 'interruption') {
    return null
  }
  for (const { item } of state.select({
    kind: 'scoped-statuses',
    turnItemId: latest.item.itemId,
    floor
  })) {
    const displayed = state.displayed(item.itemId)
    const cause = displayed && orcaStopCauseOfRow(displayed)
    if (cause) {
      return { turnItemId: latest.item.itemId, cause }
    }
  }
  return null
}
