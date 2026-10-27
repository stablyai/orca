// A crashed host cannot settle its working rows. Reopen marks them unverifiable, preserving keys
// for later runs; never invent exits (docs/reference/ssh-execution-boundary.md).

import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import {
  isSubagentGroupFallbackText,
  normalizeSubagentState,
  subagentGroupFallbackText
} from '../../../shared/native-chat-subagent-summary'
import {
  backgroundTaskFallbackText,
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskState
} from '../../../shared/native-chat/input/native-chat-background-task-row'
import { subagentFallbackText } from '../../../shared/native-chat-subagent-items'
import {
  isBackgroundTaskBlock,
  isSubagentBlock,
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatSubagentBlock,
  type NativeChatSubagentGroupBlock
} from '../../../shared/native-chat-types'

export type JournalSubagentLivenessRevision = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

export function staleSubagentRosterRevisions(
  items: Iterable<AgentJournalRenderItem>
): JournalSubagentLivenessRevision[] {
  const revisions: JournalSubagentLivenessRevision[] = []
  for (const item of items) {
    const body = lostLiveWorkJournalBody(item.body)
    if (!body) {
      continue
    }
    // A new identity would duplicate an unaddressable row.
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity || agentJournalItemKey(identity) !== item.itemId) {
      continue
    }
    revisions.push({ identity, body })
  }
  return revisions
}

/** Mark live work unverifiable; lostAt is known only when a live host observes session end. */
export function lostLiveWorkJournalBody(
  body: AgentJournalItemBody,
  lostAt?: number
): AgentJournalItemBody | null {
  if (body.kind !== 'message' || !body.blocks.some(hasStaleLiveWork)) {
    return null
  }
  return { ...body, blocks: settleBlocks(body.blocks, lostAt) }
}

function hasStaleLiveWork(block: NativeChatBlock): boolean {
  return hasWorkingChild(block) || isWorkingSubagent(block) || hasLiveBackgroundTask(block)
}

function isWorkingSubagent(block: NativeChatBlock): block is NativeChatSubagentBlock {
  return isSubagentBlock(block) && normalizeSubagentState(block.state) === 'working'
}

function hasWorkingChild(block: NativeChatBlock): block is NativeChatSubagentGroupBlock {
  return (
    isSubagentGroupBlock(block) &&
    block.agents.some((agent) => normalizeSubagentState(agent.state) === 'working')
  )
}

function hasLiveBackgroundTask(block: NativeChatBlock): block is NativeChatBackgroundTaskBlock {
  return (
    isBackgroundTaskBlock(block) &&
    !isSettledBackgroundTaskState(normalizeBackgroundTaskState(block.state))
  )
}

/** Unknown loss time must not turn app downtime into a fabricated run duration. */
function settleBlocks(blocks: readonly NativeChatBlock[], lostAt?: number): NativeChatBlock[] {
  const twinText = new Map<string, string>()
  const settled = blocks.map((block) => {
    if (hasWorkingChild(block)) {
      return settleGroup(block, lostAt)
    }
    if (isWorkingSubagent(block)) {
      const next: NativeChatSubagentBlock = {
        ...block,
        state: 'unverifiable',
        ...(lostAt !== undefined ? { settledAt: lostAt } : {})
      }
      twinText.set(subagentFallbackText(block), subagentFallbackText(next))
      return next
    }
    if (hasLiveBackgroundTask(block)) {
      const next = settleBackgroundTask(block)
      twinText.set(backgroundTaskFallbackText(block), backgroundTaskFallbackText(next))
      return next
    }
    return block
  })
  const withTwins = settled.map((block) =>
    block.type === 'text' ? { ...block, text: twinText.get(block.text) ?? block.text } : block
  )
  const rosters = withTwins.filter(isSubagentGroupBlock)
  const only = rosters.length === 1 ? rosters[0] : undefined
  if (!only) {
    return withTwins
  }
  // Older clients see only the fallback, which must agree with the structured block.
  const twin = subagentGroupFallbackText(only.agents)
  return withTwins.map((block) =>
    block.type === 'text' && isSubagentGroupFallbackText(block.text)
      ? { ...block, text: twin }
      : block
  )
}

function settleGroup(
  block: NativeChatSubagentGroupBlock,
  lostAt?: number
): NativeChatSubagentGroupBlock {
  return {
    ...block,
    agents: block.agents.map((agent) =>
      normalizeSubagentState(agent.state) === 'working'
        ? {
            ...agent,
            state: 'unverifiable' as const,
            ...(lostAt !== undefined ? { settledAt: lostAt } : {})
          }
        : agent
    )
  }
}

function settleBackgroundTask(block: NativeChatBackgroundTaskBlock): NativeChatBackgroundTaskBlock {
  const { settledAt: _settledAt, ...withoutSettledAt } = block
  return { ...withoutSettledAt, state: 'unverifiable' }
}
