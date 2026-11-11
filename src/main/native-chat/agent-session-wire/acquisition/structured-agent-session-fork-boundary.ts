import { agentSessionProviderHandleRoot } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentSessionCurrentContextRows } from '../../../../shared/agent-session/agent-session-context-clear'
import { savedRewindKeys } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalSnapshot } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'

type Checkpoint = NonNullable<
  Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]['checkpoint']
>

/** Fork admission follows the retained containing root, independently of rewind eligibility. */
export function structuredAgentSessionForkBoundary(
  snapshot: AgentJournalSnapshot,
  record: AgentSessionRecord,
  throughItemId: string,
  capability: 'checkpoint' | 'tip' = 'checkpoint'
): { checkpoint: Checkpoint; latest: boolean; nextItemId: string | null; retained: string } | null {
  const { items } = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
  const index = items.findIndex((item) => item.itemId === throughItemId)
  const selected = items[index]
  if (
    !selected ||
    !isRootAgentJournalItem(selected) ||
    selected.body.kind !== 'message' ||
    selected.body.role !== 'assistant'
  ) {
    return null
  }
  const turnId = selected.turnScope?.kind === 'turn' ? selected.turnScope.turnItemId : undefined
  const root = turnId ? items.find((item) => item.itemId === turnId) : undefined
  const turn = root ? readAgentJournalTurn(root.body) : null
  const keys = savedRewindKeys(snapshot.submissions)
  const next = items.slice(index + 1).find((item) => {
    const nextTurn = readAgentJournalTurn(item.body)
    return (
      isRootAgentJournalItem(item) &&
      (nextTurn
        ? item.itemId !== turnId
        : item.body.kind === 'message' &&
          item.body.role === 'user' &&
          item.turnScope?.kind !== 'turn' &&
          !item.body.blocks.some((block) => block.type === 'tool-result'))
    )
  })
  const nextTurn = next && readAgentJournalTurn(next.body)
  const nextIdentity = next && keys.nativeIdentity(nextTurn?.userItemId ?? next.itemId)
  const identity = keys.nativeIdentity(selected.itemId)
  const opener = turn?.userItemId ? keys.nativeIdentity(turn.userItemId) : undefined
  const head = record.providerHandleChain.at(-1)
  const settled = Boolean(
    next ||
    (turn && (turn.state === 'completed' || turn.state === 'interrupted')) ||
    record.lease.deathEvidence
  )
  const checkpoint: Checkpoint = {
    selectedItemId: keys.providerKey(selected.itemId),
    settled,
    ...(turn ? { turnId: turn.providerTurnId ?? turn.turnId } : {}),
    ...(identity?.provider === 'codex' ? { turnId: identity.turnId } : {}),
    ...(opener?.provider === 'claude'
      ? { rootMessage: { sessionId: opener.sessionId, uuid: opener.uuid } }
      : {}),
    ...(identity?.provider === 'claude'
      ? { throughMessage: { sessionId: identity.sessionId, uuid: identity.uuid } }
      : {}),
    ...(nextIdentity?.provider === 'claude'
      ? { beforeMessage: { sessionId: nextIdentity.sessionId, uuid: nextIdentity.uuid } }
      : {})
  }
  return {
    checkpoint,
    latest: !next,
    nextItemId: next?.itemId ?? null,
    retained: JSON.stringify({
      selected: selected.itemId,
      root: root?.itemId,
      identity,
      opener,
      floor: record.providerContextBoundary,
      rewind: record.rewind,
      head: capability === 'tip' ? head : head && agentSessionProviderHandleRoot(head.handle)
    })
  }
}
