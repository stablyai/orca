import { createHash } from 'node:crypto'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionCommandEntry } from '../../../../shared/agent-session/structured-agent-session-command-entry'
import type { AgentSessionUsageLimit } from '../../../../shared/agent-session/failures/agent-session-usage-limit'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { restoreJournal } from '../../agent-session-journal/replay/journal-open'
import { renderJournalStatus } from '../../agent-session-journal/projection/journal-public-read'
import { journalInputOrder } from '../../agent-session-journal/input-order/journal-input-order'
import type Database from '../../../sqlite/sync-database'
import {
  latestNativeChatUsageLimitCut,
  nativeChatUsageLimitOfRow,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'

/** Automatic continues a chain may spend before Orca leaves the chat to the person. */
export const USAGE_LIMIT_CONTINUE_CHAIN_LIMIT = 5

type ChainSubmission = Pick<AgentJournalSubmission, 'clientMessageId' | 'providerItemId' | 'origin'>

export const usageLimitContinueIdentity = (
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'>
): string => JSON.stringify([cut.turnItemId, cut.resetsAt])

/** Names the cut an automatic continue answers; its message id carries this, so the journal keeps the chain. */
export const usageLimitContinueTag = (
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'>
) => createHash('sha256').update(usageLimitContinueIdentity(cut)).digest('hex').slice(0, 16)

/** `<13-digit time>-<tag><16 random hex>`, as the sweep writes it. */
export function usageLimitContinueMessageId(at: number, tag: string, random: string): string {
  return `${Math.trunc(at).toString().padStart(13, '0')}-${tag}${random}`
}

const tagOfMessageId = (clientMessageId: string): string | null =>
  /^\d{13}-([0-9a-f]{16})[0-9a-f]{16}$/.exec(clientMessageId)?.[1] ?? null

/** The submission whose user row opened a turn: output-first turns key the submission placeholder,
 *  echo-first turns key the provider's item. Searched newest first, where an opener sits. */
function openerOf(
  submissions: readonly ChainSubmission[],
  userItemId: string,
  before: number
): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    const submission = submissions[index]!
    if (
      agentJournalSubmissionKey(submission.clientMessageId) === userItemId ||
      submission.providerItemId === userItemId
    ) {
      return index
    }
  }
  return -1
}

/** Whether the turn at `index` was opened by a slash command, read from its opener just before it.
 *  An echo-opened turn names the provider's key while its row keeps the submission's, so the nearest
 *  root user row is the opener too; the walk never reaches the turn before. */
function isCommandTurnAt(items: readonly AgentJournalRenderItem[], index: number): boolean {
  const userItemId = readAgentJournalTurn(items[index]!.body)?.userItemId
  for (let before = index - 1; userItemId && before >= 0; before -= 1) {
    const item = items[before]!
    if (
      item.itemId === userItemId ||
      (isRootAgentJournalItem(item) && item.body.kind === 'message' && item.body.role === 'user')
    ) {
      return isStructuredAgentSessionCommandEntry(item.body)
    }
    if (isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)) {
      break
    }
  }
  return false
}

/** The request turn just before the user row that opened `turnIndex`, skipping slash-command turns
 *  as the latest-turn read does; -1 when a person's request intervenes. */
function previousTurnIndex(
  items: readonly AgentJournalRenderItem[],
  turnIndex: number,
  openerKeys: ReadonlySet<string>
): number {
  for (let index = turnIndex - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (
      !isRootAgentJournalItem(item) ||
      openerKeys.has(item.itemId) ||
      isStructuredAgentSessionCommandEntry(item.body)
    ) {
      continue
    }
    if (readAgentJournalTurn(item.body)) {
      if (isCommandTurnAt(items, index)) {
        continue
      }
      return index
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      return -1
    }
  }
  return -1
}

/** A turn's usage limit, read only from the rows between it and the next turn. */
function usageLimitBetween(
  items: readonly AgentJournalRenderItem[],
  turnIndex: number,
  end: number
): AgentSessionUsageLimit | null {
  const turnItemId = items[turnIndex]!.itemId
  for (let index = turnIndex + 1; index < end; index += 1) {
    const item = items[index]!
    const limit =
      item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId
        ? nativeChatUsageLimitOfRow(item)
        : null
    if (limit) {
      return limit
    }
  }
  return null
}

/** How many automatic continues in a row ended in another usage limit, read from the journal so a
 *  restart or reopen agrees. Each step needs the exact join: the turn opened by a host submission
 *  whose message id names the cut before it. Walks back from the end, so the rows read are the
 *  chain's own; the sends searched for openers can be all of them when an opener matches none. */
export function usageLimitContinueChain(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly ChainSubmission[],
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId'>
): number {
  let turnIndex = items.length - 1
  while (turnIndex >= 0 && items[turnIndex]!.itemId !== cut.turnItemId) {
    turnIndex -= 1
  }
  let submissionBound = submissions.length
  let chain = 0
  while (chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT && turnIndex >= 0) {
    const userItemId = readAgentJournalTurn(items[turnIndex]!.body)?.userItemId
    const openerIndex = userItemId ? openerOf(submissions, userItemId, submissionBound) : -1
    const opener = openerIndex >= 0 ? submissions[openerIndex]! : null
    const tag = opener?.origin === 'host' ? tagOfMessageId(opener.clientMessageId) : null
    if (!opener || !tag || !userItemId) {
      break
    }
    const openerKeys = new Set([userItemId, agentJournalSubmissionKey(opener.clientMessageId)])
    const previous = previousTurnIndex(items, turnIndex, openerKeys)
    const limit = previous >= 0 ? usageLimitBetween(items, previous, turnIndex) : null
    if (
      limit?.resetsAt === undefined ||
      usageLimitContinueTag({ turnItemId: items[previous]!.itemId, resetsAt: limit.resetsAt }) !==
        tag
    ) {
      break
    }
    chain += 1
    turnIndex = previous
    submissionBound = openerIndex
  }
  return chain
}

/** A cut as the host's sweep reads it: with the chain that led to it. */
export type HostUsageLimitCut = NativeChatUsageLimitCut & { chain: number }

export function hostUsageLimitCut(
  snapshot: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly ChainSubmission[]
  },
  cut: NativeChatUsageLimitCut | null
): HostUsageLimitCut | null {
  return cut
    ? { ...cut, chain: usageLimitContinueChain(snapshot.items, snapshot.submissions, cut) }
    : null
}

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export function readSavedUsageLimitCut(
  db: Database.Database,
  id: string
): HostUsageLimitCut | null {
  const load = restoreJournal(db, id)
  const snapshot =
    load && !load.newer && !load.damage
      ? renderJournalStatus(load.state, journalInputOrder(load.state))
      : null
  return snapshot
    ? hostUsageLimitCut(
        snapshot,
        latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions)
      )
    : null
}
