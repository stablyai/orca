import { canReplaceBackgroundTaskState } from '../../../shared/native-chat/input/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionChildWorkProducer } from '../../native-chat/agent-session-wire/observations/structured-agent-session-subagent-rows'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpPromptTurnTracker } from '../protocol/acp-session-runtime-options'
import type { AcpStructuredSessionAdapterDeps } from '../session/acp-structured-session-adapter-deps'
import type { AcpStructuredLaneDeps } from './acp-structured-lane'

/** Return persisted background-task IDs still eligible for terminal recovery, or `null` before bind. */
export function acpRecoverableBackgroundTaskIds(
  events?: StructuredAgentSessionEventSink
): ReadonlySet<string> | null {
  const history = events?.journalHistory?.()
  if (!history) {
    return null
  }
  const ids = new Set<string>()
  history.visitItems((key) => {
    const body = history.item(key)?.body
    if (body?.kind !== 'message') {
      return
    }
    for (const block of body.blocks) {
      if (isBackgroundTaskBlock(block) && canReplaceBackgroundTaskState(block.state, 'done')) {
        ids.add(block.taskId)
      }
    }
  })
  return ids
}

/** Build the optional `turnTracker` runtime option bound to recoverable journal task IDs. */
export function acpTurnTrackerOption(
  spec: AcpLaunchSpec,
  env: Readonly<Record<string, string>>,
  now: () => number,
  events?: StructuredAgentSessionEventSink
): { turnTracker?: AcpPromptTurnTracker } {
  return spec.turnTracker
    ? { turnTracker: spec.turnTracker(env, now, () => acpRecoverableBackgroundTaskIds(events)) }
    : {}
}

/** Build child-work evidence and error callbacks for an ACP structured session lane. */
export function acpLaneChildWorkDelivery(
  deps: AcpStructuredSessionAdapterDeps,
  sessionId: string,
  producer?: StructuredAgentSessionChildWorkProducer
): Pick<AcpStructuredLaneDeps, 'onChildWorkEvidence' | 'onChildWorkFailure'> {
  return {
    onChildWorkEvidence: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence, producer),
    onChildWorkFailure: (error) =>
      deps.logger?.error('publishing ACP child work failed', {
        scope: 'acp-child-work',
        sessionId,
        error
      })
  }
}
