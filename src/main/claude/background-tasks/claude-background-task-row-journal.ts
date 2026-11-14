import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { backgroundTaskJournalBody as claudeBackgroundTaskBody } from '../../../shared/native-chat/input/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionLifecycleJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { estimateStructuredAgentSessionItemBytes } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  claudeBackgroundTaskIdentity,
  resolveClaudeBackgroundTaskIdentity
} from './claude-background-task-identity'

const MAX_RESOLVED_TASK_IDENTITIES = 512
const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

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
  const serialized = JSON.stringify([body, row.linkage])
  if (serialized === row.lastSerialized) {
    return ADMITTED
  }
  beforeAppend?.()
  const identity = claudeBackgroundTaskIdentity(id, row.generation)
  // A reused row belongs to the current run, so it must count as executing.
  const appendOptions = {
    ...row.linkage,
    turnScope: turnScope(),
    executes: true as const,
    ...(lifecycle ? { lifecycle: true } : {})
  }
  const publishOptions = lifecycle ? { lifecycle: true } : {}
  const toolUseId = row.block.parentToolUseId
  const resolveIdentity = (journal: StructuredAgentSessionLifecycleJournal) =>
    identities.resolve(journal, id, toolUseId)
  const appendAndPublish = sink.tryAppendResolvedItemAndPublish
  let admission: StructuredAgentSessionSinkAdmission
  if (sink.tryReviseResolvedItemAndPublish) {
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    // A saved alias is at most512 characters, each at most6 JSON bytes.
    const reservedBytes =
      estimateStructuredAgentSessionItemBytes(identitySizeBound, body) + 512 * 6 + 64
    admission = sink.tryReviseResolvedItemAndPublish(
      reservedBytes,
      (journal) => {
        const resolved = resolveIdentity(journal)
        const saved = journal.itemBody(agentJournalItemKey(resolved))
        const savedBlock =
          saved?.kind === 'message' ? saved.blocks.find(isBackgroundTaskBlock) : undefined
        const block = body.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
        const alias = block?.parentToolUseId ?? savedBlock?.parentToolUseId
        return {
          identity: resolved,
          body:
            block && alias && block.parentToolUseId === undefined
              ? claudeBackgroundTaskBody({ ...block, parentToolUseId: alias })
              : body
        }
      },
      appendOptions
    )
  } else if (appendAndPublish) {
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
