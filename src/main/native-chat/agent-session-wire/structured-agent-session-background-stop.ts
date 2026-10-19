// A background Stop: the strip's Stop of one task, or of every task the records offer one.

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
  /** The session's child records: a background Stop reaches the tasks they offer a stop. */
  childWork?: () => readonly AgentChildWorkView[] | undefined
  /** Hands the host the stops the provider accepted, as evidence about the runs it sent them to.
   *  Never throws: recording it is bookkeeping, and cannot fail the Stop. */
  acknowledgeStops?: (evidence: AgentChildWorkEvidence[]) => void
  /** Capture runtime lifetimes alongside listed targets, before the Stop can await. */
  captureStops?: (
    targets: readonly (AgentChildWorkView & { providerId: string })[]
  ) => CapturedChildWorkStops
  /** Work the host could not list at the Stop's capture, and the provider child that holds it. */
  unlisted?: { present: () => boolean; stop: () => Promise<void> }
}

/** `atRest`: no lead turn runs, so the user's Stop all may end an agent holding unlisted work. */
export async function stopStructuredAgentSessionBackgroundWork(
  ctx: Pick<AgentSessionTurnContext, 'adapter' | 'sessionId' | 'fence'>,
  input: Pick<StructuredAgentSessionBackgroundStopInput, 'acknowledgeStops'> & {
    /** Captured before the stop goes out: its acknowledgement may end only these runs. */
    targets: readonly (AgentChildWorkView & { providerId: string })[]
    /** A listed ID may be sent only while its captured runtime lifetime still stands. */
    targetCurrent?: (handleId: string) => boolean
    /** Unlisted work was already present when this Stop captured its targets. */
    unlisted?: { stop: () => Promise<void> }
    /** The host could not read the task list the targets came from. */
    unreadable?: true
  },
  atRest: () => boolean
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const { targetCurrent } = input
  const targets = targetCurrent
    ? input.targets.filter((target) => targetCurrent(target.providerId))
    : input.targets
  const acknowledged: AgentChildWorkStopAcknowledgement[] = []
  // Nothing listed has a stop to send; an agent without a stop route would refuse even none.
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
          // A batch that fails part way still ended each run it was answered for first.
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
  // An initially unlisted helper needs the agent's end; later work cannot expand this Stop.
  if (input.unlisted && atRest()) {
    await input.unlisted.stop()
    return { cancelled: true }
  }
  // A list the host could not read proves no task ended: unconfirmed, never "nothing to stop".
  if (input.unreadable) {
    throw new Error('the background task list could not be read')
  }
  return { cancelled: background?.cancelled === true }
}
