import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { backgroundTaskJournalBody } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import { claudeBackgroundTaskIdentity } from './claude-background-task-identity'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export { claudeBackgroundTaskIdentity } from './claude-background-task-identity'

export const claudeBackgroundTaskBody = backgroundTaskJournalBody

export function writeClaudeBackgroundTaskRow(
  sink: StructuredAgentSessionEventSink,
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
  // The writer chooses the generation against the task's saved incarnations.
  const resolution = {
    kind: 'background-task' as const,
    taskId: id,
    ...(row.toolUseId !== undefined ? { toolUseId: row.toolUseId } : {}),
    body
  }
  const appendAndPublish = sink.tryAppendResolvedItemAndPublish
  let admission: StructuredAgentSessionSinkAdmission
  if (appendAndPublish) {
    // Budget for any safe generation suffix before the deferred sink resolves its durable identity.
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    admission = appendAndPublish(identitySizeBound, resolution, appendOptions)
  } else if (sink.tryAppendResolvedItem) {
    const identitySizeBound = claudeBackgroundTaskIdentity(id, Number.MAX_SAFE_INTEGER)
    admission = sink.tryAppendResolvedItem(identitySizeBound, resolution, appendOptions)
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
