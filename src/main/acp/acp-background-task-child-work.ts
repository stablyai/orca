import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../shared/agent-status-child-work-evidence'
import { isSettledBackgroundTaskState } from '../../shared/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../shared/agent-status-child-work-value-guards'
import type { AcpTimelineEvent } from './acp-timeline-event'

/** Keeps a task's handle apart from a subagent's, so a Stop knows which route it takes. */
const TASK_ID_PREFIX = 'acp-task:'

function acpBackgroundTaskHandle(taskId: string): AgentChildWorkEvidenceHandle {
  return { idKind: 'task_id', id: `${TASK_ID_PREFIX}${taskId}` }
}

/** The agent's own task id behind a child handle, when the handle names a background task. */
export function acpBackgroundTaskStopId(childId: string): string | undefined {
  return childId.startsWith(TASK_ID_PREFIX) ? childId.slice(TASK_ID_PREFIX.length) : undefined
}

function backgroundTaskBlocks(event: AcpTimelineEvent) {
  return event.type === 'item.update' && 'body' in event && event.body.kind === 'message'
    ? event.body.blocks.filter(isBackgroundTaskBlock)
    : []
}

export function isAcpBackgroundTaskChildWorkEvent(event: AcpTimelineEvent): boolean {
  return backgroundTaskBlocks(event).length > 0
}

/** A running task is a live record until it ends, and then its record goes, like a command's. */
export function acpBackgroundTaskChildWork(
  event: AcpTimelineEvent,
  observedAt: number,
  stoppable: boolean
): AgentChildWorkEvidence[] {
  return backgroundTaskBlocks(event).flatMap((block): AgentChildWorkEvidence[] => {
    const handle = acpBackgroundTaskHandle(block.taskId)
    // A handle too long to record could not address the agent's own task either.
    if (handle.id.length > AGENT_CHILD_WORK_ID_MAX_LENGTH) {
      return []
    }
    if (isSettledBackgroundTaskState(block.state)) {
      return [{ type: 'removed', observedAt, handle }]
    }
    return [
      {
        type: 'live',
        observedAt,
        child: {
          handle,
          kind: block.kind,
          residency: 'background',
          state:
            block.state === 'monitoring' || block.state === 'waiting' ? block.state : 'working',
          ...(block.label ? { description: block.label } : {}),
          stoppable
        }
      }
    ]
  })
}
