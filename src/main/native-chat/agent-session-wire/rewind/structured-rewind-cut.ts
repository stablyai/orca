import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  savedRewindKeys,
  type AgentSessionRewindRecord
} from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type {
  JournalRewindCut,
  JournalRewindSelection
} from '../../agent-session-journal/journal-domain-rewind-cut'

export type StructuredRewindCut = JournalRewindCut

/** The SQL planner returns only the provider boundary; retained history stays on the writer. */
export function structuredRewindCut(journal: AgentSessionJournal, target: JournalRewindSelection) {
  return journal.reads.rewindCut(target)
}

/** Admission only; already-saved rewinds complete even if their target is no longer eligible. */
export async function isStructuredRewindTarget(journal: AgentSessionJournal, itemId: string) {
  return (await journal.reads.rewindTarget(itemId)).eligible
}

export async function providerItemIdOf(
  journal: AgentSessionJournal,
  itemId: string
): Promise<string> {
  const { submission } = await journal.reads.input({ kind: 'input-for-item', itemId })
  return savedRewindKeys(submission ? [submission] : []).providerKey(itemId)
}

/** Only records prepared by older builds lack a native predecessor proof. */
export function legacyRewindTurns(
  _journal: AgentSessionJournal,
  cut: StructuredRewindCut,
  _threadId: string
) {
  return 'beforeTurnId' in cut
    ? { beforeTurnId: cut.beforeTurnId, keptTurnId: cut.keptTurnId }
    : null
}

// Only rewind replaces an existing context, so a changed epoch proves replacement committed.
export async function rewindJournalCut(
  record: AgentSessionRecord | null,
  journal: AgentSessionJournal,
  rewind: AgentSessionRewindRecord
): Promise<{ alreadyReplaced: boolean; cut: StructuredRewindCut | null }> {
  const alreadyReplaced = (await journal.reads.cursor()).epoch !== rewind.expectedEpoch
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  const cut =
    alreadyReplaced || !record || !head
      ? null
      : await structuredRewindCut(journal, {
          itemId: rewind.itemId,
          provider: record.provider,
          nativeId: head.nativeId
        })
  return { alreadyReplaced, cut }
}

/** The main conversation turn a row belongs to: its own Codex key on the main thread, else the turn
 *  record its scope names, else the turn record it is. A subagent thread's own turn ids are never
 *  the main thread's: its rows belong to the main turn they arrived in. */
export function turnMembership(
  journal: { itemBody(itemId: string): AgentJournalItemBody | null },
  items: readonly AgentJournalRenderItem[],
  threadId: string,
  providerKey: (itemId: string) => string
): (item: AgentJournalRenderItem) => string | undefined {
  const recordTurn = (itemId: string) => {
    const turn = readAgentJournalTurn(journal.itemBody(itemId) ?? undefined)
    return turn?.providerTurnId ?? turn?.turnId
  }
  const byItem = new Map<string, string | undefined>()
  for (const item of items) {
    const identity = parseAgentJournalItemKey(providerKey(item.itemId))
    byItem.set(
      item.itemId,
      sourceThreadTurnMembership(
        identity,
        threadId,
        item.turnScope?.kind === 'turn'
          ? recordTurn(item.turnScope.turnItemId)
          : recordTurn(item.itemId)
      )
    )
  }
  return (item) => byItem.get(item.itemId)
}

/** A child-thread identity never overrides the source conversation's scoped lifecycle turn. */
export function sourceThreadTurnMembership(
  identity: ReturnType<typeof parseAgentJournalItemKey>,
  threadId: string,
  lifecycleTurn: string | undefined
): string | undefined {
  return identity?.provider === 'codex' && identity.threadId === threadId
    ? identity.turnId
    : lifecycleTurn
}
