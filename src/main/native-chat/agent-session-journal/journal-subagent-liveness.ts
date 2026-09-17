// A roster row left claiming live children by a host that is gone.
//
// The writing host revises its `subagent-group` rows in place while it can see
// the children, and sweeps whatever is still `working` when the provider goes
// away. A host that DIED — crash, quit, force-restart — does neither: its last
// revision goes on saying `working`, and nothing replays those children, so no
// later event can ever settle them. Opening the journal is the one moment a new
// host can state the truth about the old one: contact was lost. That is
// `unverifiable`, never a synthesized exit — see
// `docs/reference/ssh-execution-boundary.md`.
//
// Reconciles JOURNAL ROWS, not roster state: nothing here seeds the producer's
// in-process group map, so the roster's known limitation is untouched.

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
} from '../../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatSubagentGroupBlock
} from '../../../shared/native-chat-types'

export type JournalSubagentLivenessRevision = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

/** The revisions a reopened journal owes: one per row still claiming a live
 *  child. Empty — the common case — when nothing was left mid-flight. */
export function staleSubagentRosterRevisions(
  items: Iterable<AgentJournalRenderItem>
): JournalSubagentLivenessRevision[] {
  const revisions: JournalSubagentLivenessRevision[] = []
  for (const item of items) {
    const body = item.body
    if (body.kind !== 'message' || !body.blocks.some(hasStaleLiveWork)) {
      continue
    }
    // A key that will not parse cannot be re-addressed, and appending under a
    // fresh identity would duplicate the row rather than revise it.
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity || agentJournalItemKey(identity) !== item.itemId) {
      continue
    }
    revisions.push({ identity, body: { ...body, blocks: settleBlocks(body.blocks) } })
  }
  return revisions
}

function hasStaleLiveWork(block: NativeChatBlock): boolean {
  return hasWorkingChild(block) || hasLiveBackgroundTask(block)
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

/** No `settledAt`: the child stopped being observable at an unknown moment, and
 *  stamping the reopen would report the time the app was down as how long it
 *  ran. Readers already draw an unverifiable child with no stamp as having no
 *  known run length. */
function settleBlocks(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  const backgroundTaskTwinText = new Map<string, string>()
  const settled = blocks.map((block) => {
    if (hasWorkingChild(block)) {
      return settleGroup(block)
    }
    if (hasLiveBackgroundTask(block)) {
      const next = settleBackgroundTask(block)
      backgroundTaskTwinText.set(
        backgroundTaskFallbackText(block),
        backgroundTaskFallbackText(next)
      )
      return next
    }
    return block
  })
  const withBackgroundTaskTwins = settled.map((block) =>
    block.type === 'text'
      ? { ...block, text: backgroundTaskTwinText.get(block.text) ?? block.text }
      : block
  )
  const rosters = withBackgroundTaskTwins.filter(isSubagentGroupBlock)
  const only = rosters.length === 1 ? rosters[0] : undefined
  if (!only) {
    return withBackgroundTaskTwins
  }
  // The plain-text twin is all a client without the block type ever shows, so it
  // has to move with the block or the two would disagree about the same row.
  const twin = subagentGroupFallbackText(only.agents)
  return withBackgroundTaskTwins.map((block) =>
    block.type === 'text' && isSubagentGroupFallbackText(block.text)
      ? { ...block, text: twin }
      : block
  )
}

function settleGroup(block: NativeChatSubagentGroupBlock): NativeChatSubagentGroupBlock {
  return {
    ...block,
    agents: block.agents.map((agent) =>
      normalizeSubagentState(agent.state) === 'working'
        ? { ...agent, state: 'unverifiable' as const }
        : agent
    )
  }
}

function settleBackgroundTask(block: NativeChatBackgroundTaskBlock): NativeChatBackgroundTaskBlock {
  const { settledAt: _settledAt, ...withoutSettledAt } = block
  return { ...withoutSettledAt, state: 'unverifiable' }
}
