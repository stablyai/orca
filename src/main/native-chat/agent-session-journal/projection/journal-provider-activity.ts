import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'

/** Count provider output by execution owner; client/recovery writes cannot extend turns. */
export function observeJournalProviderActivity(
  state: Pick<JournalReducerState, 'providerActivityAt'>,
  row: JournalRow,
  itemId: string,
  body: AgentJournalItemBody,
  savedAt: number,
  fence: number
): void {
  if (!isJournalProviderActivity(row.recovered, itemId, body)) {
    return
  }
  state.providerActivityAt.set(fence, Math.max(state.providerActivityAt.get(fence) ?? 0, savedAt))
}

export function isJournalProviderActivity(
  recovered: true | undefined,
  itemId: string,
  body: AgentJournalItemBody
): boolean {
  if (recovered || !isProviderActivity(body)) {
    return false
  }
  const identity = parseAgentJournalItemKey(itemId)
  // Codex detail rows use Orca IDs; fallback rows already identify their provider.
  if (
    !identity ||
    (identity.provider === 'orca' &&
      !identity.clientMessageId.startsWith('codex-item:') &&
      !(body.kind === 'status' && body.providerFrame !== undefined))
  ) {
    return false
  }
  return true
}

function isProviderActivity(body: AgentJournalItemBody): boolean {
  if (body.kind === 'message') {
    return body.role !== 'user'
  }
  if (body.kind === 'tool-call') {
    return body.endedAs === undefined
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending'
  }
  const turn = readAgentJournalTurn(body)
  return turn ? turn.state === 'running' : true
}
