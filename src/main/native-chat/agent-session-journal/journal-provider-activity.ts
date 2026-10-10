import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Saved output extends a turn; client actions and recovery writes do not. */
export function observeJournalProviderActivity(
  state: Pick<JournalReducerState, 'providerActivityAt'>,
  row: JournalRow,
  itemId: string,
  body: AgentJournalItemBody,
  savedAt: number
): void {
  if (row.recovered || !isProviderActivity(body)) {
    return
  }
  const identity = parseAgentJournalItemKey(itemId)
  // Codex detail rows use the Orca namespace; fallback rows already name their provider.
  if (
    !identity ||
    (identity.provider === 'orca' &&
      !identity.clientMessageId.startsWith('codex-item:') &&
      !(body.kind === 'status' && body.providerFrame !== undefined))
  ) {
    return
  }
  state.providerActivityAt.set(
    row.fence,
    Math.max(state.providerActivityAt.get(row.fence) ?? 0, savedAt)
  )
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
