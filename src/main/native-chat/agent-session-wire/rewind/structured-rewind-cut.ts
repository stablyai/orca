import { isInheritedAgentSessionItem } from '../../../../shared/agent-session/agent-session-fork'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  savedRewindKeys,
  isAgentSessionRewindTarget,
  type AgentSessionRewindRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalLinkageFields } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../../agent-session-journal/context-epochs/journal-epoch-replacement'
// Derive cuts from the journal’s retained old epoch so admission and recovery agree without copying history.

export type StructuredRewindCut = {
  /** Excludes rows below the /clear floor. */
  kept: JournalReplacementItem[]
} & (
  | {
      beforeTurnId: string
    }
  | {
      /** Fork-based providers cut at the removed prompt. */
      beforeMessage: { sessionId: string; uuid: string }
    }
)

export function structuredRewindCut(
  journal: AgentSessionJournal,
  target: { itemId: string; provider: string; nativeId: string }
): StructuredRewindCut | null {
  const snapshot = journal.currentRead()
  const floor = journal.context.floor()
  const items = floor
    ? snapshot.items.filter((item) => item.sequence > floor.sequence)
    : snapshot.items
  const { providerKey, omitted, nativeIdentity } = savedRewindKeys(snapshot.submissions)
  const selected = items.find((item) => item.itemId === target.itemId)
  const key = selected ? nativeIdentity(selected.itemId) : null
  const cutUnusable =
    !selected ||
    !(
      key !== null &&
      (key.provider === 'claude' || key.provider === 'zcode') &&
      key.provider === target.provider &&
      key.sessionId === target.nativeId
    )
  // Fork-cut providers rewind by resuming a fork the provider built; the cut token rides the uuid
  // slot (claude's parent uuid, zcode's turn key) and the session must match the head.
  if (!cutUnusable) {
    // Messages before an earlier fork still cut at their original position.
    const boundary = items.findIndex((item) => item.itemId === target.itemId)
    const keptTurns = new Set(items.slice(0, boundary).flatMap((item) => scopedTurn(item) ?? []))
    const keptRows = items.filter((item, index) => {
      const turn = scopedTurn(item)
      // Late rows follow their kept turn even if they arrived after the cut.
      return (
        !omitted.has(item.itemId) &&
        (index < boundary || (turn !== undefined && keptTurns.has(turn)))
      )
    })
    return {
      beforeMessage: {
        sessionId: key.sessionId,
        uuid: key.provider === 'zcode' ? key.turnId : key.uuid
      },
      kept: keptRows.map((item) => keptRow(journal, item))
    }
  }
  if (
    key?.provider !== 'codex' ||
    target.provider !== 'codex' ||
    key.threadId !== target.nativeId
  ) {
    if (cutUnusable) {
      createStructuredAgentSessionLogger().warn('rewind cut resolved no branch', {
        scope: 'structured-rewind-cut',
        provider: target.provider,
        headNativeId: target.nativeId,
        itemId: target.itemId,
        hasRow: selected !== undefined,
        rowCount: items.length,
        hasFloor: floor !== null,
        resolvedKey: key
          ? {
              provider: key.provider,
              matchesHead:
                key.provider === 'codex'
                  ? key.threadId === target.nativeId
                  : key.sessionId === target.nativeId
            }
          : null
      })
    }
    return null
  }
  const turnOf = turnMembership(journal, items, key.threadId, providerKey)
  const boundary = items.findIndex((item) => turnOf(item) === key.turnId)
  const keptTurns = new Set(items.slice(0, boundary).flatMap((item) => turnOf(item) ?? []))
  const keptRows = items.filter((item, index) => {
    const turnId = turnOf(item)
    // Late rows follow their kept turn even if they arrived after the cut.
    return (
      !omitted.has(item.itemId) &&
      (index < boundary || (turnId !== undefined && keptTurns.has(turnId)))
    )
  })
  return {
    beforeTurnId: key.turnId,
    kept: keptRows.map((item) => keptRow(journal, item))
  }
}

/** Admission only; already-saved rewinds complete even if their target is no longer eligible. */
export function isStructuredRewindTarget(
  journal: AgentSessionJournal,
  itemId: string,
  boundary?: NonNullable<AgentSessionRecord['forkedFrom']>['childBoundary']
): boolean {
  const item = journal.currentRead().items.find((row) => row.itemId === itemId)
  return (
    item !== undefined &&
    !isInheritedAgentSessionItem(journal.currentRead().items, boundary, itemId) &&
    isAgentSessionRewindTarget(
      item,
      (turnItemId) => readAgentJournalTurn(journal.itemBody(turnItemId) ?? undefined)?.userItemId
    )
  )
}

function scopedTurn(item: AgentJournalRenderItem): string | undefined {
  return item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : undefined
}

/** Use provider item keys, not host-only turn records; include pre-/clear history the provider retains. */
function lastListedTurn(
  rows: readonly AgentJournalRenderItem[],
  threadId: string,
  providerKey: (itemId: string) => string
): string | null {
  const seen = new Set<string>()
  let last: string | null = null
  for (const row of rows) {
    const identity = parseAgentJournalItemKey(providerKey(row.itemId))
    if (
      identity?.provider === 'codex' &&
      identity.threadId === threadId &&
      !seen.has(identity.turnId)
    ) {
      seen.add(identity.turnId)
      last = identity.turnId
    }
  }
  return last
}

export function providerItemIdOf(journal: AgentSessionJournal, itemId: string): string {
  return savedRewindKeys(
    [journal.inputOrder.inputForItem(itemId)].flatMap((input) => (input ? [input] : []))
  ).providerKey(itemId)
}

/** The main conversation turn a row belongs to: its own Codex key on the main thread, else the turn
 *  record its scope names, else the turn record it is. A subagent thread's own turn ids are never
 *  the main thread's: its rows belong to the main turn they arrived in. */
export function turnMembership(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
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
      identity?.provider === 'codex' && identity.threadId === threadId
        ? identity.turnId
        : item.turnScope?.kind === 'turn'
          ? recordTurn(item.turnScope.turnItemId)
          : recordTurn(item.itemId)
    )
  }
  return (item) => byItem.get(item.itemId)
}

function keptRow(
  journal: AgentSessionJournal,
  { itemId, observedAt, turnScope, ...linkage }: AgentJournalRenderItem
): JournalReplacementItem {
  const body = journal.itemBody(itemId)
  const identity = parseAgentJournalItemKey(itemId)
  if (!body || !identity) {
    throw new Error('agent_session_rewind:missing-retained-item')
  }
  const { ownerFence, executionOwner, ...echo } = journal.itemProvenance(itemId)
  return {
    identity,
    ...echo,
    body,
    observedAt,
    ...(turnScope ? { turnScope } : {}),
    // Preserve provenance so rewind cannot revive dead-generation work.
    ownerFence: ownerFence ?? 0,
    ...(executionOwner === undefined ? {} : { executionOwner }),
    ...agentJournalLinkageFields(linkage)
  }
}

/** Only records prepared by older builds lack a native predecessor proof. */
export function legacyRewindTurns(
  journal: AgentSessionJournal,
  cut: StructuredRewindCut,
  threadId: string
) {
  if (!('beforeTurnId' in cut)) {
    return null
  }
  const keptIds = new Set(cut.kept.map((item) => agentJournalItemKey(item.identity)))
  const floor = journal.context.floor()
  return {
    beforeTurnId: cut.beforeTurnId,
    keptTurnId: lastListedTurn(
      journal
        .currentRead()
        .items.filter(
          (item) => (floor && item.sequence <= floor.sequence) || keptIds.has(item.itemId)
        ),
      threadId,
      savedRewindKeys(journal.currentRead().submissions).providerKey
    )
  }
}

// Only rewind replaces an existing epoch, so a changed epoch proves replacement committed.
export function rewindJournalCut(
  record: AgentSessionRecord | null,
  journal: AgentSessionJournal,
  rewind: AgentSessionRewindRecord
): { alreadyReplaced: boolean; cut: StructuredRewindCut | null } {
  const alreadyReplaced = journal.cursor().epoch !== rewind.expectedEpoch
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  const cut =
    alreadyReplaced || !record || !head
      ? null
      : structuredRewindCut(journal, {
          itemId: rewind.itemId,
          provider: record.provider,
          nativeId: head.nativeId
        })
  return { alreadyReplaced, cut }
}
