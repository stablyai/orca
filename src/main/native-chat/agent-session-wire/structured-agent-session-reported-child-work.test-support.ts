import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'

/** What a provider reported to leave these records: a live edge per live one, an ending per
 *  settled one. Lets a test that serves records through a stub sink tell the host's own
 *  open-work set the same story. */
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
