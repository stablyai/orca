import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isBackgroundTaskBlock } from '../../shared/native-chat/native-chat-types'

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
  let maxGeneration = 0
  let matchingGeneration: number | undefined
  let parentlessGeneration: number | undefined
  for (const { itemId, body } of withKeyPrefix(
    agentJournalItemKey(claudeBackgroundTaskIdentity(id))
  )) {
    const identity = parseAgentJournalItemKey(itemId)
    if (!identity || identity.provider !== 'orca') {
      continue
    }
    const taskBlock = body.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
    if (!taskBlock || taskBlock.taskId !== id) {
      continue
    }
    const generation = persistedTaskGeneration(identity.clientMessageId, id)
    if (generation === null) {
      continue
    }
    maxGeneration = Math.max(maxGeneration, generation)
    if (taskBlock.parentToolUseId === toolUseId) {
      matchingGeneration = Math.max(matchingGeneration ?? 0, generation)
    } else if (taskBlock.parentToolUseId === undefined) {
      parentlessGeneration = Math.max(parentlessGeneration ?? 0, generation)
    }
  }
  // A prior parentless row cannot be proved distinct from the later aliased outcome.
  return claudeBackgroundTaskIdentity(
    id,
    matchingGeneration ?? parentlessGeneration ?? (maxGeneration === 0 ? 1 : maxGeneration + 1)
  )
}

function persistedTaskGeneration(clientMessageId: string, taskId: string): number | null {
  const base = `claude-background-task:${taskId}`
  if (clientMessageId === base) {
    return 1
  }
  const prefix = `${base}#`
  if (!clientMessageId.startsWith(prefix)) {
    return null
  }
  const generation = Number(clientMessageId.slice(prefix.length))
  return Number.isSafeInteger(generation) && generation > 1 ? generation : null
}
