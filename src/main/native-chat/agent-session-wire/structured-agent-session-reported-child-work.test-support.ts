import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'

/** Mirror display records into provider evidence so stub sinks and host open-work state agree. */
export function reportedChildWork(
  views: readonly AgentChildWorkView[],
  observedAt: number
): AgentChildWorkEvidence[] {
  return views.map((view) => {
    const handle = { idKind: 'task_id' as const, id: view.providerId ?? view.id }
    return view.membership === 'settled'
      ? { type: 'ended', observedAt, handle, outcome: view.outcome ?? 'unknown' }
      : {
          type: 'live',
          observedAt,
          child: {
            handle,
            kind: view.kind,
            residency: 'background',
            state: view.state === 'done' ? 'idle' : view.state,
            stoppable: view.stoppable
          }
        }
  })
}
