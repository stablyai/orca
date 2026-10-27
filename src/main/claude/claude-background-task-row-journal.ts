import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { backgroundTaskJournalBody } from '../../shared/native-chat/input/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'

const MAX_RESOLVED_TASK_IDENTITIES = 512
const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

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

export const claudeBackgroundTaskBody = backgroundTaskJournalBody

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
  /** The turn the row belongs to, read once `beforeAppend` has opened it. */
  turnScope: () => AgentJournalTurnScope,
  /** Open the turn before append; duplicate writes and retries must not open another. */
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
  // A reused row belongs to the current run, so it must count as executing.
  const appendOptions = {
    turnScope: turnScope(),
    executes: true as const,
    ...(lifecycle ? { lifecycle: true } : {})
  }
  const publishOptions = lifecycle ? { lifecycle: true } : {}
  const resolveIdentity = (journal: StructuredAgentSessionLifecycleJournal) =>
    identities.resolve(journal, id, row.toolUseId)
  const appendAndPublish = sink.tryAppendResolvedItemAndPublish
  let admission: StructuredAgentSessionSinkAdmission
  if (appendAndPublish) {
    // Budget for any safe generation suffix before the deferred sink resolves its durable identity.
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
