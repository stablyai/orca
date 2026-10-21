// Where a rewind cuts the conversation, derived from the journal alone. The journal keeps the old
// epoch until the rewind completes, so admission and recovery derive the same cut, and the saved
// rewind record names the target instead of copying the history it keeps.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { isAgentSessionRewindTarget } from '../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

export type StructuredRewindCut = {
  /** The rows after any /clear floor the rewound conversation keeps, in journal order. */
  kept: JournalReplacementItem[]
} & (
  | {
      /** The provider turn the rewind removes, with every later one. */
      beforeTurnId: string
      /** The last provider turn the rewind keeps; null when it keeps none. */
      keptTurnId: string | null
    }
  | {
      /** A provider that forks to rewind cuts at the message itself: the prompt it removes. */
      beforeMessage: { sessionId: string; uuid: string }
    }
)

/** The cut at `itemId` for the session's current provider handle; null when it can't be cut there. */
export function structuredRewindCut(
  journal: AgentSessionJournal,
  target: { itemId: string; provider: string; nativeId: string }
): StructuredRewindCut | null {
  const snapshot = journal.snapshot()
  const floor = journal.context.floor()
  const items = floor
    ? snapshot.items.filter((item) => item.sequence > floor.sequence)
    : snapshot.items
  const { providerKey, omitted } = submissionKeys(snapshot.submissions)
  const selected = items.find((item) => item.itemId === target.itemId)
  const key = selected ? parseAgentJournalItemKey(providerKey(selected.itemId)) : null
  if (key?.provider === 'claude' && target.provider === 'claude') {
    // Any session the chat ran: a message from before an earlier rewind's fork is still cut there.
    const boundary = items.findIndex((item) => item.itemId === target.itemId)
    const keptTurns = new Set(items.slice(0, boundary).flatMap((item) => scopedTurn(item) ?? []))
    const keptRows = items.filter((item, index) => {
      const turn = scopedTurn(item)
      // A kept turn's row can land after the cut, as a late provider item does.
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
    // A kept turn's row can land after the cut, as a late provider item does.
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

/** Whether a new rewind may return to `itemId`. Asked only on admission: a rewind already saved
 *  completes wherever it cuts. */
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

/** The newest main-thread turn the provider lists among `rows`: from a provider item's own key,
 *  since a host turn record may name a turn the provider never lists. Rows before a /clear count,
 *  since the provider keeps them. */
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

/** The provider's key for a journal row; an accepted message keeps Orca's own until then. */
export function providerItemIdOf(journal: AgentSessionJournal, itemId: string): string {
  return submissionKeys(journal.snapshot().submissions).providerKey(itemId)
}

// Accepted messages keep Orca's key in the journal; the rebuilt epoch has no submission to tie them
// to, so they take the provider's.
function submissionKeys(submissions: readonly AgentJournalSubmission[]): {
  providerKey: (itemId: string) => string
  /** Messages a rewind never keeps: queued ones survive it on their own, rejected ones never ran. */
  omitted: ReadonlySet<string>
} {
  const providerKeys = new Map<string, string>()
  const omitted = new Set<string>()
  for (const submission of submissions) {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (isQueuedAgentJournalSubmission(submission) || submission.dispatchState === 'rejected') {
      omitted.add(key)
    } else if (submission.dispatchState === 'accepted' && submission.providerItemId) {
      providerKeys.set(key, submission.providerItemId)
    }
  }
  return { providerKey: (itemId) => providerKeys.get(itemId) ?? itemId, omitted }
}

/** The main conversation turn a row belongs to: its own Codex key on the main thread, else the turn
 *  record its scope names, else the turn record it is. A subagent thread's own turn ids are never
 *  the main thread's: its rows belong to the main turn they arrived in. */
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
  const { ownerFence, executionOwner } = journal.itemProvenance(itemId)
  return {
    identity,
    body: renameRewindTurnOpener(body, providerKey),
    observedAt,
    ...(turnScope ? { turnScope } : {}),
    // The old fold's provenance, so a rewind never makes a dead generation's work current.
    ownerFence: ownerFence ?? 0,
    ...(executionOwner === undefined ? {} : { executionOwner }),
    ...agentJournalLinkageFields(linkage)
  }
}

/** A turn record names the message that opened it; it follows that message to its provider key. */
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
