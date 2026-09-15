import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { backgroundTaskFallbackText } from '../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  type NativeChatBackgroundTaskBlock
} from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'

/** Durable identity for one RUN of a task.
 *
 *  A provider may reuse a task id for a distinct later invocation, and a row
 *  keyed by the id alone would overwrite the first run's transcript history
 *  instead of leaving it standing beside the restart. The generation suffix
 *  separates them. Generation 1 carries no suffix, so every row written before
 *  generations existed keeps the key it already has. */
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

export function claudeBackgroundTaskBody(
  block: NativeChatBackgroundTaskBlock
): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'system',
    blocks: [{ type: 'text', text: backgroundTaskFallbackText(block) }, { ...block }]
  }
}

/** Reconcile one queued row against the durable run identity after a rebind. */
export function resolveClaudeBackgroundTaskIdentity(
  journal: StructuredAgentSessionLifecycleJournal,
  id: string,
  toolUseId: string | undefined
): AgentJournalItemIdentity {
  let maxGeneration = 0
  let matchingGeneration: number | undefined
  journal.visitItems((itemId, _sequence, body) => {
    const identity = parseAgentJournalItemKey(itemId)
    if (!identity || identity.provider !== 'orca') {
      return
    }
    const taskBlock = body.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
    if (!taskBlock || taskBlock.taskId !== id) {
      return
    }
    const generation = persistedTaskGeneration(identity.clientMessageId, id)
    if (generation === null) {
      return
    }
    maxGeneration = Math.max(maxGeneration, generation)
    if (taskBlock.parentToolUseId === toolUseId) {
      matchingGeneration = Math.max(matchingGeneration ?? 0, generation)
    }
  })
  return claudeBackgroundTaskIdentity(
    id,
    matchingGeneration ?? (maxGeneration === 0 ? 1 : maxGeneration + 1)
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

export function writeClaudeBackgroundTaskRow(
  sink: StructuredAgentSessionEventSink,
  id: string,
  row: ClaudeBackgroundTaskRow,
  /** Runs only when a row is really appended, so a duplicate delivery that
   *  changes nothing never opens a turn. */
  beforeAppend?: () => void
): void {
  const body = claudeBackgroundTaskBody(row.block)
  const serialized = JSON.stringify(body)
  if (serialized === row.lastSerialized) {
    return
  }
  row.lastSerialized = serialized
  beforeAppend?.()
  const identity = claudeBackgroundTaskIdentity(id, row.generation)
  // Generation is translator-local and resets when a provider stream is
  // recreated. Keep unresolved writes from distinct provider runs queued side
  // by using the provider's parent tool identity as the coalescing discriminator.
  const coalescingKey = JSON.stringify(['claude-background-task', id, row.toolUseId ?? null])
  const resolveIdentity = sink.tryAppendResolvedItem
  if (resolveIdentity) {
    // Reserve enough space for any safe generation suffix; the actual identity
    // is selected once the deferred sink is bound to the durable journal.
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    resolveIdentity(
      identitySizeBound,
      body,
      (journal) => resolveClaudeBackgroundTaskIdentity(journal, id, row.toolUseId),
      {
        coalescingKey
      }
    )
    sink.publish()
    return
  }
  sink.appendItem(identity, body, {
    coalescingKey
  })
  sink.publish()
}
