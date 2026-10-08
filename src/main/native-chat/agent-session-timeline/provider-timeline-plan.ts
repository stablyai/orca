// One grammar event's journal writes, admitted as one sink transition.
//
// What each write says, and whether it writes at all, is decided by its resolver when the
// transition reaches its turn in the journal's write queue. `onAdmitted` work (the state, text
// marked written) runs only when the sink takes the transition, so a refused event leaves the
// assembler exactly as it was and re-applying it is the retry.

import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../agent-session-wire/structured-agent-session-transition'

/** The sink calls the assembler needs: one-operation transitions, and the journal as it stands. */
export type ProviderTimelineSink = Required<
  Pick<StructuredAgentSessionEventSink, 'tryAppendTransition' | 'journalItems'>
> &
  Pick<StructuredAgentSessionEventSink, 'setActivity'>

type ItemStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>
type SettlementStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'settlement' }>

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export class ProviderTimelinePlan {
  private readonly steps: StructuredAgentSessionTransitionStep[] = []
  private readonly admitted: (() => void)[] = []
  private lifecycle = false

  item(step: Omit<ItemStep, 'kind'>, lifecycle = false): void {
    this.steps.push({ kind: 'item', ...step })
    this.lifecycle ||= lifecycle
  }

  settlement(step: Omit<SettlementStep, 'kind'>): void {
    this.steps.push({ kind: 'settlement', ...step })
    this.lifecycle = true
  }

  /** Runs once the sink takes the transition. */
  onAdmitted(change: () => void): void {
    this.admitted.push(change)
  }

  submit(sink: ProviderTimelineSink): StructuredAgentSessionSinkAdmission {
    if (this.steps.length > 0) {
      const admission = sink.tryAppendTransition({
        steps: this.steps,
        lifecycle: this.lifecycle,
        publish: true
      })
      if (!admission.accepted) {
        return admission
      }
    }
    for (const change of this.admitted) {
      change()
    }
    return ADMITTED
  }
}

/** The sink as the assembler needs it; null for a sink without transitions or a journal view. */
export function providerTimelineSink(
  sink: StructuredAgentSessionEventSink
): ProviderTimelineSink | null {
  const { tryAppendTransition, journalItems, setActivity } = sink
  if (!tryAppendTransition || !journalItems) {
    return null
  }
  return {
    tryAppendTransition: (transition) => tryAppendTransition.call(sink, transition),
    journalItems: () => journalItems.call(sink),
    ...(setActivity
      ? {
          setActivity: (activity: AgentSessionTurnActivity | null) =>
            setActivity.call(sink, activity)
        }
      : {})
  }
}
