// Derive cuts from the journal’s retained old epoch so admission and recovery agree without copying history.

import { savedRewindKeys, isAgentSessionRewindTarget } from '../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

export type StructuredRewindCut = {
  /** Excludes rows below the /clear floor. */
  kept: JournalReplacementItem[]
} & (
  | {
      beforeTurnId: string
      keptTurnId: string | null
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
  const snapshot = journal.snapshot()
  const floor = journal.context.floor()
  const items = floor
    ? snapshot.items.filter((item) => item.sequence > floor.sequence)
    : snapshot.items
  const { providerKey, omitted, nativeIdentity } = savedRewindKeys(snapshot.submissions)
  const selected = items.find((item) => item.itemId === target.itemId)
  const key = selected ? nativeIdentity(selected.itemId) : null
  if (key?.provider === 'claude' && target.provider === 'claude') {
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
      beforeMessage: { sessionId: key.sessionId, uuid: key.uuid },
      kept: keptRows.map((item) => keptRow(journal, item, providerKey))
    }
  }
  if (
    key?.provider !== 'codex' ||
    target.provider !== 'codex' ||
    key.threadId !== target.nativeId
  ) {
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
  const keptIds = new Set(keptRows.map(({ itemId }) => itemId))
  return {
    beforeTurnId: key.turnId,
    keptTurnId: lastListedTurn(
      snapshot.items.filter(
        (item) => (floor && item.sequence <= floor.sequence) || keptIds.has(item.itemId)
      ),
      key.threadId,
      providerKey
    ),
    kept: keptRows.map((item) => keptRow(journal, item, providerKey))
  }
}

/** Admission only; already-saved rewinds complete even if their target is no longer eligible. */
export function isStructuredRewindTarget(journal: AgentSessionJournal, itemId: string): boolean {
  const item = journal.snapshot().items.find((row) => row.itemId === itemId)
  return (
    item !== undefined &&
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
  return savedRewindKeys(journal.snapshot().submissions).providerKey(itemId)
}

/** Child rows belong to their enclosing main turn, never their child-thread turn ID. */
function turnMembership(
  journal: AgentSessionJournal,
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
  { itemId, observedAt, turnScope, ...linkage }: AgentJournalRenderItem,
  providerKey: (itemId: string) => string
): JournalReplacementItem {
  const body = journal.itemBody(itemId)
  const identity = parseAgentJournalItemKey(providerKey(itemId))
  if (!body || !identity) {
    throw new Error('agent_session_rewind:missing-retained-item')
  }
  const { ownerFence, executionOwner, ...echo } = journal.itemProvenance(itemId)
  return {
    identity,
    ...echo,
    body: renameRewindTurnOpener(body, providerKey),
    observedAt,
    ...(turnScope ? { turnScope } : {}),
    // Preserve provenance so rewind cannot revive dead-generation work.
    ownerFence: ownerFence ?? 0,
    ...(executionOwner === undefined ? {} : { executionOwner }),
    ...agentJournalLinkageFields(linkage)
  }
}

/** Rename the opener with its message when converting to provider keys. */
function renameRewindTurnOpener(
  body: AgentJournalItemBody,
  rename: (itemId: string) => string
): AgentJournalItemBody {
  if (body.kind === 'turn' && body.userItemId !== undefined) {
    return { ...body, userItemId: rename(body.userItemId) }
  }
  const lifecycle = body.kind === 'status' ? body.turnLifecycle : undefined
  return body.kind === 'status' && lifecycle?.userItemId !== undefined
    ? { ...body, turnLifecycle: { ...lifecycle, userItemId: rename(lifecycle.userItemId) } }
    : body
}
