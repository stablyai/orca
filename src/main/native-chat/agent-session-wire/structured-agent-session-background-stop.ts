import {
  agentChildWorkStopEvidence,
  type AgentChildWorkStopAcknowledgement
} from '../../../shared/agent-child-work-stop-targets'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { CapturedChildWorkStops } from './structured-agent-session-status-ownership'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

export type StructuredAgentSessionBackgroundStopInput = {
  taskId?: string
  childWork?: () => readonly AgentChildWorkView[] | undefined
  /** Record accepted-stop evidence without throwing or failing the Stop. */
  acknowledgeStops?: (evidence: AgentChildWorkEvidence[]) => void
  /** Capture exact runtime lifetimes before awaiting Stop. */
  captureStops?: (
    targets: readonly (AgentChildWorkView & { providerId: string })[]
  ) => CapturedChildWorkStops
  /** Unlisted work and the provider child holding it. */
  unlisted?: { present: () => boolean; stop: () => Promise<void> }
}

/** Stop all may end unlisted work’s agent only when no lead turn runs. */
export async function stopStructuredAgentSessionBackgroundWork(
  ctx: Pick<AgentSessionTurnContext, 'adapter' | 'sessionId' | 'fence'>,
  input: Pick<StructuredAgentSessionBackgroundStopInput, 'acknowledgeStops'> & {
    /** Acknowledgements apply only to runs captured before Stop. */
    targets: readonly (AgentChildWorkView & { providerId: string })[]
    /** Recheck captured runtime lifetime before sending each listed ID. */
    targetCurrent?: (handleId: string) => boolean
    unlisted?: { stop: () => Promise<void> }
    unreadable?: true
  },
  atRest: () => boolean
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const { targetCurrent } = input
  const targets = targetCurrent
    ? input.targets.filter((target) => targetCurrent(target.providerId))
    : input.targets
  const acknowledged: AgentChildWorkStopAcknowledgement[] = []
  // Avoid unsupported stop-route refusal when no listed target needs stopping.
  const background =
    targets.length === 0
      ? undefined
      : await ctx.adapter
          .stopBackgroundTasks?.({
            sessionId: ctx.sessionId,
            fence: ctx.fence,
            taskIds: targets.map((target) => target.providerId),
            acknowledge: (acknowledgement) => void acknowledged.push(acknowledgement)
          })
          // Preserve earlier acknowledgements even if the batch later fails.
          .finally(() => {
            if (acknowledged.length > 0) {
              input.acknowledgeStops?.(
                agentChildWorkStopEvidence(targets, acknowledged, Date.now())
              )
            }
          })
  if (background?.stillRunning) {
    return background
  }
  // Later work must not expand this Stop’s captured targets.
  if (input.unlisted && atRest()) {
    await input.unlisted.stop()
    return { cancelled: true }
  }
  // Unreadable lists prove no task ended; report uncertainty instead of an empty target set.
  if (input.unreadable) {
    throw new Error('the background task list could not be read')
  }
  return { cancelled: background?.cancelled === true }
}
