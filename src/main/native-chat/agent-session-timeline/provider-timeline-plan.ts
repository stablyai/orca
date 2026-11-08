// Resolve rows on the write lane; advance state/text bookkeeping only after admission so refusal is retryable.

import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../agent-session-wire/journal-ingress/structured-agent-session-transition'
import type { JournalStepOutcome } from '../agent-session-journal/writing/journal-writer-step'

export type ProviderTimelineSink = Required<
  Pick<StructuredAgentSessionEventSink, 'tryAppendTransition' | 'journalItems'>
> &
  Pick<StructuredAgentSessionEventSink, 'setActivity' | 'written' | 'observeSettledTurns'>

type ItemStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>
type SettlementStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'settlement' }>
type StepInput<T> = T extends StructuredAgentSessionTransitionStep ? Omit<T, 'kind'> : never

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export class ProviderTimelinePlan {
  private readonly steps: StructuredAgentSessionTransitionStep[] = []
  private readonly admitted: (() => void)[] = []
  private readonly resolved: ((outcomes: readonly JournalStepOutcome[]) => void)[] = []
  private lifecycle = false

  item(
    step: StepInput<ItemStep>,
    lifecycle = false,
    onResolved?: (outcome: JournalStepOutcome) => void
  ): void {
    const index = this.steps.length
    this.steps.push({ kind: 'item', ...step })
    if (onResolved) {
      this.resolved.push((outcomes) => {
        const outcome = outcomes[index]
        if (outcome) {
          onResolved(outcome)
        }
      })
    }
    this.lifecycle ||= lifecycle
  }

  settlement(step: StepInput<SettlementStep>): void {
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
    let admitted = false
    let synchronousOutcomes: readonly JournalStepOutcome[] | undefined
    const resolve = (outcomes: readonly JournalStepOutcome[]) => {
      if (admitted) {
        this.resolved.forEach((change) => change(outcomes))
      } else {
        synchronousOutcomes = outcomes
      }
    }
    if (this.steps.length > 0) {
      const admission = sink.tryAppendTransition({
        steps: this.steps,
        lifecycle: this.lifecycle,
        publish: true,
        onResolved: resolve,
        ...(onPublished ? { onPublished } : {})
      })
      if (!admission.accepted) {
        return admission
      }
    }
    for (const change of this.admitted) {
      change()
    }
    admitted = true
    if (synchronousOutcomes) {
      resolve(synchronousOutcomes)
    }
    return ADMITTED
  }
}

export function providerTimelineSink(
  sink: StructuredAgentSessionEventSink
): ProviderTimelineSink | null {
  const { tryAppendTransition, journalItems, setActivity, written, observeSettledTurns } = sink
  if (!tryAppendTransition || !journalItems) {
    return null
  }
  return {
    tryAppendTransition: (transition) => tryAppendTransition.call(sink, transition),
    journalItems: () => journalItems.call(sink),
    ...(observeSettledTurns
      ? { observeSettledTurns: (listener) => observeSettledTurns.call(sink, listener) }
      : {}),
    ...(written ? { written: () => written.call(sink) } : {}),
    ...(setActivity
      ? {
          setActivity: (activity: AgentSessionTurnActivity | null) =>
            setActivity.call(sink, activity)
        }
      : {})
  }
}
