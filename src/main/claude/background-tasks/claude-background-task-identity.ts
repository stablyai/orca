import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import type { StructuredAgentSessionLifecycleJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'

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

export function claudeBackgroundTaskIdentity(
  taskId: string,
  generation = 1
): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: `claude-background-task:${taskId}${generation > 1 ? `#${generation}` : ''}`
  }
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

export function resolveClaudeBackgroundTaskDescriptor(
  journal: StructuredAgentSessionLifecycleJournal,
  id: string,
  toolUseId?: string
): ClaudeBackgroundTaskDescriptor {
  const index: ClaudeBackgroundTaskIndex = { aliases: new Map() }
  journal.visitItems((itemId, _sequence, body) => {
    if (body.kind !== 'message') {
      return
    }
    const block = body.blocks.find(isBackgroundTaskBlock)
    if (block?.taskId === id) {
      indexClaudeBackgroundTask(index, itemId, id, block.parentToolUseId, {})
    }
  })
  return (
    selectClaudeBackgroundTask(index, toolUseId) ?? {
      identity: claudeBackgroundTaskIdentity(id, (index.latest?.generation ?? 0) + 1),
      generation: (index.latest?.generation ?? 0) + 1,
      toolUseId,
      linkage: {}
    }
  )
}

export function resolveClaudeBackgroundTaskIdentity(
  journal: StructuredAgentSessionLifecycleJournal,
  id: string,
  toolUseId: string | undefined
): AgentJournalItemIdentity {
  return resolveClaudeBackgroundTaskDescriptor(journal, id, toolUseId).identity
}
