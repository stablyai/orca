// Provider preflight returns provider items only. The host's lifecycle rows are its own record, so
// a rewind that takes the provider list as the new epoch must splice those rows back beside the
// provider item each one followed. Provider items carry neither turn scope nor producer, so each
// keeps the ones its retained row held.

import { parseCodexGoalJournalItemId } from '../../codex/codex-goal-journal-identity'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'

type RetainedRow = AgentSessionRewindRecord['retained'][number]

export function isRetainedHostLifecycleRow(item: RetainedRow): boolean {
  const identity = parseAgentJournalItemKey(item.itemId)
  return (
    readAgentJournalTurn(item.body as AgentJournalItemBody) !== null ||
    parseCodexGoalJournalItemId(item.itemId) !== null ||
    // A conversation command's entry and result: the provider's history holds neither.
    (item.body.kind === 'message' && item.body.command !== undefined) ||
    (identity?.provider === 'orca' && identity.clientMessageId.startsWith('command-'))
  )
}

/** `reference` fixes where each host row sits; provider items are the ordered spine. */
export function mergeRetainedHostLifecycleRows(
  reference: readonly RetainedRow[],
  providerItems: readonly RetainedRow[]
): RetainedRow[] {
  const spineIndex = new Map(providerItems.map((item, index) => [item.itemId, index]))
  const held = new Map(reference.map((item) => [item.itemId, item]))
  const rowsAfter = new Map<number, RetainedRow[]>()
  let anchor = -1
  for (const item of reference) {
    if (!isRetainedHostLifecycleRow(item)) {
      anchor = spineIndex.get(item.itemId) ?? anchor
    } else if (!spineIndex.has(item.itemId)) {
      rowsAfter.set(anchor, [...(rowsAfter.get(anchor) ?? []), item])
    }
  }
  const merged = [...(rowsAfter.get(-1) ?? [])]
  providerItems.forEach((item, index) =>
    merged.push(withHeldAttribution(item, held.get(item.itemId)), ...(rowsAfter.get(index) ?? []))
  )
  return merged.map((item) =>
    held.has(item.itemId) || item.turnScope ? item : withProviderTurnScope(item, merged)
  )
}

/** The rebuilt epoch's item for one retained row, with the scope and producer it was written with. */
export function retainedRowReplacement(row: RetainedRow): AgentJournalProducerLinkage & {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt: number
  turnScope?: AgentJournalTurnScope
} {
  const identity = parseAgentJournalItemKey(row.itemId)
  if (!identity) {
    throw new Error('agent_session_rewind:invalid-retained-identity')
  }
  const { agentId, parentAgentId, providerParentRef, producerKind, attempt, turnScope } = row
  const scope =
    turnScope?.kind === 'turn' && turnScope.turnItemId
      ? { kind: 'turn' as const, turnItemId: turnScope.turnItemId }
      : turnScope?.kind === 'thread'
        ? { kind: 'thread' as const }
        : undefined
  return {
    identity,
    body: restoreRewindJournalBody(row.body),
    observedAt: row.observedAt,
    ...(scope ? { turnScope: scope } : {}),
    ...(agentId === undefined ? {} : { agentId }),
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
    ...(providerParentRef === undefined ? {} : { providerParentRef }),
    ...(producerKind === 'agent' || producerKind === 'background' ? { producerKind } : {}),
    ...(attempt === undefined ? {} : { attempt })
  }
}

function withHeldAttribution(item: RetainedRow, held: RetainedRow | undefined): RetainedRow {
  if (!held) {
    return item
  }
  const { itemId: _itemId, body: _body, observedAt: _observedAt, ...attribution } = held
  return { ...item, ...attribution }
}

/** A provider item the old epoch never held joins the turn record for its provider turn: the
 *  turn's own record, or the command turn that claimed it. Otherwise the rebuild places it. */
function withProviderTurnScope(item: RetainedRow, merged: readonly RetainedRow[]): RetainedRow {
  const identity = parseAgentJournalItemKey(item.itemId)
  const providerTurnId = identity?.provider === 'codex' ? identity.turnId : null
  const turnRecord = providerTurnId
    ? merged.find((candidate) => {
        const turn = readAgentJournalTurn(candidate.body as AgentJournalItemBody)
        return turn?.turnId === providerTurnId || turn?.providerTurnId === providerTurnId
      })
    : undefined
  return turnRecord ? { ...item, turnScope: { kind: 'turn', turnItemId: turnRecord.itemId } } : item
}
