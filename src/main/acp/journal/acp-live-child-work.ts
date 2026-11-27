import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveEvidence
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpChildStops } from '../acp-dialects/acp-dialect'
import { acpBackgroundTaskChildWork } from '../timeline/acp-background-task-child-work'

/** More live children than this can't be real; later ones aren't restated. */
const MAX_LIVE_CHILDREN = 256
const NO_STOPS: AcpChildStops = { subagents: false, backgroundTasks: false }

type Restate = (stops: AcpChildStops, at: number) => AgentChildWorkEvidence | undefined

/**
 * A lane's background tasks and subagents as published, with Stop where the agent supports it.
 * Each live child's latest evidence is kept rebuildable, so stop support learned late (a kept agent
 * is probed once its output flows) is restated on the children already published.
 */
export class AcpLiveChildWork {
  private readonly live = new Map<string, Restate>()

  constructor(
    private readonly stops: () => AcpChildStops | undefined,
    /** Tasks Orca inferred and cannot stop. */
    private readonly inferred: (taskId: string) => boolean
  ) {}

  /** A background task's evidence from its timeline event. */
  tasks(event: ProviderTimelineEvent, at: number): AgentChildWorkEvidence[] {
    const build = (stops: AcpChildStops, now: number) =>
      acpBackgroundTaskChildWork(event, now, stops.backgroundTasks, this.inferred)
    const evidence = build(this.stops() ?? NO_STOPS, at)
    this.record(evidence, (id) => (stops, now) => build(stops, now).find((e) => liveId(e) === id))
    return evidence
  }

  /** A subagent's evidence, Stop only where both the agent and its handle allow it. */
  subagents(evidence: AgentChildWorkEvidence[]): AgentChildWorkEvidence[] {
    const masked = (stops: AcpChildStops) =>
      evidence.map((edge) =>
        edge.type === 'live'
          ? {
              ...edge,
              child: { ...edge.child, stoppable: stops.subagents && edge.child.stoppable }
            }
          : edge
      )
    this.record(evidence, (id) => (stops) => masked(stops).find((edge) => liveId(edge) === id))
    return masked(this.stops() ?? NO_STOPS)
  }

  /** The live children again, with the stops known now and nothing said of their operation. */
  restated(at: number): AgentChildWorkLiveEvidence[] {
    const stops = this.stops() ?? NO_STOPS
    return [...this.live.values()].flatMap((restate) => {
      const edge = restate(stops, at)
      if (edge?.type !== 'live') {
        return []
      }
      const { operation: _operation, ...child } = edge.child
      return [{ type: 'live' as const, observedAt: at, child }]
    })
  }

  private record(evidence: AgentChildWorkEvidence[], restate: (id: string) => Restate): void {
    for (const edge of evidence) {
      const id = liveId(edge)
      if (edge.type === 'ended' || edge.type === 'removed') {
        this.live.delete(edge.handle.id)
      } else if (id !== null && (this.live.has(id) || this.live.size < MAX_LIVE_CHILDREN)) {
        this.live.set(id, restate(id))
      }
    }
  }
}

function liveId(edge: AgentChildWorkEvidence): string | null {
  return edge.type === 'live' ? edge.child.handle.id : null
}
