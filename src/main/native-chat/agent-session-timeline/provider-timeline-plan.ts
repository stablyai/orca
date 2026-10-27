// Resolve rows on the write lane; advance state/text bookkeeping only after admission so refusal is retryable.

import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../agent-session-wire/structured-agent-session-transition'

export type ProviderTimelineSink = Required<
  Pick<StructuredAgentSessionEventSink, 'tryAppendTransition' | 'journalItems'>
> &
  Pick<StructuredAgentSessionEventSink, 'setActivity' | 'written'>

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

  onAdmitted(change: () => void): void {
    this.admitted.push(change)
  }

  submit(
    sink: ProviderTimelineSink,
    onPublished?: () => void
  ): StructuredAgentSessionSinkAdmission {
    if (this.steps.length > 0) {
      const admission = sink.tryAppendTransition({
        steps: this.steps,
        lifecycle: this.lifecycle,
        publish: true,
        ...(onPublished ? { onPublished } : {})
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

export function providerTimelineSink(
  sink: StructuredAgentSessionEventSink
): ProviderTimelineSink | null {
  const { tryAppendTransition, journalItems, setActivity, written } = sink
  if (!tryAppendTransition || !journalItems) {
    return null
  }
  return {
    tryAppendTransition: (transition) => tryAppendTransition.call(sink, transition),
    journalItems: () => journalItems.call(sink),
    ...(written ? { written: () => written.call(sink) } : {}),
    ...(setActivity
      ? {
          setActivity: (activity: AgentSessionTurnActivity | null) =>
            setActivity.call(sink, activity)
        }
      : {})
  }
}
