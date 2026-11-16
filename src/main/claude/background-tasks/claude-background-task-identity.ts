import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'

export type ClaudeBackgroundTaskDescriptor = {
  identity: AgentJournalItemIdentity
  generation: number
  toolUseId?: string
  linkage: AgentJournalProducerLinkage
}

export type ClaudeBackgroundTaskIndex = {
  latest?: ClaudeBackgroundTaskDescriptor
  unresolved?: ClaudeBackgroundTaskDescriptor
  aliases: Map<string, ClaudeBackgroundTaskDescriptor>
}

/** Generation suffixes preserve restarted runs; generation 1 retains the legacy journal key. */
export function claudeBackgroundTaskIdentity(
  taskId: string,
  generation = 1
): AgentJournalItemIdentity {
  const key =
    generation > 1
      ? `claude-background-task:${taskId}#${generation}`
      : `claude-background-task:${taskId}`
  return { provider: 'orca', clientMessageId: key }
}

/** Choose among the task's saved incarnations, which all share its key prefix. */
export function resolveClaudeBackgroundTaskIdentity(
  withKeyPrefix: (prefix: string) => Iterable<AgentJournalRenderItem>,
  id: string,
  toolUseId: string | undefined
): AgentJournalItemIdentity {
  const index: ClaudeBackgroundTaskIndex = { aliases: new Map() }
  for (const { itemId, body, ...linkage } of withKeyPrefix(
    agentJournalItemKey(claudeBackgroundTaskIdentity(id))
  )) {
    const block = body.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
    if (block?.taskId === id) {
      indexClaudeBackgroundTask(index, itemId, id, block.parentToolUseId, linkage)
    }
  }
  return (
    selectClaudeBackgroundTask(index, toolUseId)?.identity ??
    claudeBackgroundTaskIdentity(id, (index.latest?.generation ?? 0) + 1)
  )
}
export function indexClaudeBackgroundTask(
  index: ClaudeBackgroundTaskIndex,
  itemId: string,
  taskId: string,
  toolUseId: string | undefined,
  linkage: AgentJournalProducerLinkage
): void {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return
  }
  const base = `claude-background-task:${taskId}`
  const generation =
    identity.clientMessageId === base
      ? 1
      : identity.clientMessageId.startsWith(`${base}#`)
        ? Number(identity.clientMessageId.slice(base.length + 1))
        : Number.NaN
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return
  }
  const descriptor = { identity, generation, toolUseId, linkage }
  if (!index.latest || generation >= index.latest.generation) {
    index.latest = descriptor
  }
  if (toolUseId === undefined) {
    if (!index.unresolved || generation >= index.unresolved.generation) {
      index.unresolved = descriptor
    }
  } else {
    const prior = index.aliases.get(toolUseId)
    if (!prior || generation >= prior.generation) {
      index.aliases.set(toolUseId, descriptor)
    }
  }
}

export function selectClaudeBackgroundTask(
  index: ClaudeBackgroundTaskIndex | undefined,
  toolUseId?: string
): ClaudeBackgroundTaskDescriptor | undefined {
  return toolUseId === undefined
    ? index?.latest
    : (index?.aliases.get(toolUseId) ?? index?.unresolved)
}
