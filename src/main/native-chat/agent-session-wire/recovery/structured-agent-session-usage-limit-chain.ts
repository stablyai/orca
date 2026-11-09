import { createHash } from 'node:crypto'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { commandTurnsOf } from '../../../../shared/agent-session/structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { restoreJournal } from '../../agent-session-journal/replay/journal-open'
import { renderJournalStatus } from '../../agent-session-journal/projection/journal-public-read'
import { journalInputOrder } from '../../agent-session-journal/input-order/journal-input-order'
import type Database from '../../../sqlite/sync-database'
import {
  latestNativeChatUsageLimitCut,
  nativeChatTurnUsageLimit,
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

/** The request turn just before `before`, skipping steers and command turns as the latest-turn read does. */
function previousTurn(
  items: readonly AgentJournalRenderItem[],
  before: number,
  commandTurns: Pick<ReadonlySet<string>, 'has'>
): AgentJournalRenderItem | null {
  for (let index = before - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (
      !isRootAgentJournalItem(item) ||
      isStructuredAgentSessionNonRequestRow(item, commandTurns)
    ) {
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      return null
    }
    if (readAgentJournalTurn(item.body)) {
      return item
    }
  }
  return null
}

/** How many automatic continues in a row ended in another usage limit, read from the journal so a
 *  restart or reopen agrees. Each step needs the exact join: the turn opened by a host submission
 *  whose message id names the cut before it. */
export function usageLimitContinueChain(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly ChainSubmission[],
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId'>
): number {
  const position = new Map(items.map((item, index) => [item.itemId, index]))
  const commandTurns = commandTurnsOf(items, undefined)
  let turnItemId = cut.turnItemId
  let chain = 0
  while (chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT) {
    const turnIndex = position.get(turnItemId)
    const userItemId =
      turnIndex === undefined ? undefined : readAgentJournalTurn(items[turnIndex]!.body)?.userItemId
    if (turnIndex === undefined || !userItemId) {
      break
    }
    // Output-first turns key the submission placeholder; echo-first turns key the provider's item.
    const opener = submissions.find(
      (submission) =>
        agentJournalSubmissionKey(submission.clientMessageId) === userItemId ||
        submission.providerItemId === userItemId
    )
    const tag = opener?.origin === 'host' ? tagOfMessageId(opener.clientMessageId) : null
    const userIndex =
      position.get(userItemId) ??
      (opener ? position.get(agentJournalSubmissionKey(opener.clientMessageId)) : undefined) ??
      turnIndex
    const previous = tag ? previousTurn(items, Math.min(userIndex, turnIndex), commandTurns) : null
    const limit = previous ? nativeChatTurnUsageLimit(items, previous.itemId) : null
    if (
      !previous ||
      limit?.resetsAt === undefined ||
      usageLimitContinueTag({ turnItemId: previous.itemId, resetsAt: limit.resetsAt }) !== tag
    ) {
      break
    }
    chain += 1
    turnItemId = previous.itemId
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
