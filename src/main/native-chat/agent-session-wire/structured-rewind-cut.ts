// Derive cuts from the journal’s retained old epoch so admission and recovery agree without copying history.

import {
  savedRewindKeys,
  isAgentSessionRewindTarget
} from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { StructuredRewindForkTarget } from './structured-agent-session-adapter'

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
      beforeMessage: StructuredRewindForkTarget
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
  // Messages before an earlier fork still cut at their original position.
  const selected = items.findIndex((item) => item.itemId === target.itemId)
  const key = selected === -1 ? null : nativeIdentity(target.itemId)
  if (key?.provider === 'claude' && target.provider === 'claude') {
    return {
      beforeMessage: { sessionId: key.sessionId, uuid: key.uuid },
      kept: rowsBefore(items, selected, omitted).map((item) => keptRow(journal, item, providerKey))
    }
  }
  if (target.provider === 'pi' && selected !== -1) {
    const prompts = items.slice(selected).flatMap((item) => {
      const text = omitted.has(item.itemId) ? null : piPromptText(item, journal)
      return text === null ? [] : [{ itemId: item.itemId, text }]
    })
    // Pi forks only at a prompt it received, never at a command or subagent row.
    return prompts[0]?.itemId === target.itemId
      ? {
          beforeMessage: { sessionId: target.nativeId, prompts: prompts.map(({ text }) => text) },
          kept: rowsBefore(items, selected, omitted).map((item) =>
            keptRow(journal, item, providerKey)
          )
        }
      : null
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

/** Rows before the cut, plus late rows of the turns it keeps. */
function rowsBefore(
  items: readonly AgentJournalRenderItem[],
  boundary: number,
  omitted: ReadonlySet<string>
): AgentJournalRenderItem[] {
  const keptTurns = new Set(items.slice(0, boundary).flatMap((item) => scopedTurn(item) ?? []))
  return items.filter((item, index) => {
    const turn = scopedTurn(item)
    // Late rows follow their kept turn even if they arrived after the cut.
    return (
      !omitted.has(item.itemId) && (index < boundary || (turn !== undefined && keptTurns.has(turn)))
    )
  })
}

/** The prompt text Pi stored for a main-chat user message, joined as the prompt was sent. */
function piPromptText(item: AgentJournalRenderItem, journal: AgentSessionJournal): string | null {
  const body = journal.itemBody(item.itemId)
  if (
    body?.kind !== 'message' ||
    body.role !== 'user' ||
    body.command !== undefined ||
    body.sentAs !== undefined ||
    item.agentId !== undefined
  ) {
    return null
  }
  return body.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
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
