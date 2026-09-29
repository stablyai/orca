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
  StructuredAgentSessionLifecycleJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'

const MAX_RESOLVED_TASK_IDENTITIES = 512
const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

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
  let parentlessGeneration: number | undefined
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
    } else if (taskBlock.parentToolUseId === undefined) {
      parentlessGeneration = Math.max(parentlessGeneration ?? 0, generation)
    }
  })
  // A prior parentless row cannot be proved distinct from the later aliased outcome.
  return claudeBackgroundTaskIdentity(
    id,
    matchingGeneration ?? parentlessGeneration ?? (maxGeneration === 0 ? 1 : maxGeneration + 1)
  )
}

/** Resolves each immutable provider run once per bound journal epoch. */
export class ClaudeBackgroundTaskIdentityResolver {
  private journal: StructuredAgentSessionLifecycleJournal | null = null
  private epoch: string | null = null
  private readonly identities = new Map<string, AgentJournalItemIdentity>()

  resolve = (
    journal: StructuredAgentSessionLifecycleJournal,
    id: string,
    toolUseId: string | undefined
  ): AgentJournalItemIdentity => {
    if (this.journal !== journal || this.epoch !== journal.epoch) {
      this.journal = journal
      this.epoch = journal.epoch
      this.identities.clear()
    }
    const key = JSON.stringify([id, toolUseId ?? null])
    const cached = this.identities.get(key)
    if (cached) {
      this.identities.delete(key)
      this.identities.set(key, cached)
      return cached
    }
    const identity = resolveClaudeBackgroundTaskIdentity(journal, id, toolUseId)
    this.identities.set(key, identity)
    if (this.identities.size > MAX_RESOLVED_TASK_IDENTITIES) {
      const oldest = this.identities.keys().next()
      if (!oldest.done) {
        this.identities.delete(oldest.value)
      }
    }
    return identity
  }

  clear(): void {
    this.journal = null
    this.epoch = null
    this.identities.clear()
  }
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
  identities: ClaudeBackgroundTaskIdentityResolver,
  id: string,
  row: ClaudeBackgroundTaskRow,
  /** Runs before admission to preserve turn-before-row ordering; duplicate
   *  delivery skips it, and a retry reuses the turn the first attempt opened. */
  beforeAppend?: () => void,
  lifecycle = false
): StructuredAgentSessionSinkAdmission {
  const body = claudeBackgroundTaskBody(row.block)
  const serialized = JSON.stringify(body)
  if (serialized === row.lastSerialized) {
    return ADMITTED
  }
  beforeAppend?.()
  const identity = claudeBackgroundTaskIdentity(id, row.generation)
  // Generation is translator-local and resets when a provider stream is
  // recreated. Keep unresolved writes from distinct provider runs queued side
  // by using the provider's parent tool identity as the coalescing discriminator.
  const coalescingKey = JSON.stringify(['claude-background-task', id, row.toolUseId ?? null])
  const appendOptions = { coalescingKey, ...(lifecycle ? { lifecycle: true } : {}) }
  const publishOptions = lifecycle ? { lifecycle: true } : {}
  const resolveIdentity = (journal: StructuredAgentSessionLifecycleJournal) =>
    identities.resolve(journal, id, row.toolUseId)
  const appendAndPublish = sink.tryAppendResolvedItemAndPublish
  let admission: StructuredAgentSessionSinkAdmission
  if (appendAndPublish) {
    // Reserve enough space for any safe generation suffix; the actual identity
    // is selected once the deferred sink is bound to the durable journal.
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    admission = appendAndPublish(identitySizeBound, body, resolveIdentity, appendOptions)
  } else if (sink.tryAppendResolvedItem) {
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    admission = sink.tryAppendResolvedItem(identitySizeBound, body, resolveIdentity, appendOptions)
    if (admission.accepted) {
      admission = sink.tryPublish
        ? sink.tryPublish(publishOptions)
        : (sink.publish(publishOptions), ADMITTED)
    }
  } else if (sink.tryAppendItem) {
    admission = sink.tryAppendItem(identity, body, appendOptions)
    if (admission.accepted) {
      admission = sink.tryPublish
        ? sink.tryPublish(publishOptions)
        : (sink.publish(publishOptions), ADMITTED)
    }
  } else {
    sink.appendItem(identity, body, appendOptions)
    sink.publish(publishOptions)
    admission = ADMITTED
  }
  if (admission.accepted) {
    row.lastSerialized = serialized
  }
  return admission
}
