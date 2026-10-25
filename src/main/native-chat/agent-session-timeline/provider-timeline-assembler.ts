// Adapters translate and retry refused events; admission alone advances assembler state.
// Deferred writes resolve from current journal state, preserving other writers’ answers and Stops.
// Each provider child gets a fresh assembler and generation.

import type { AgentType } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionCommandRun } from '../agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionDeltaCoalescerDeps } from '../agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import {
  PROVIDER_TIMELINE_OVER_BUDGET,
  providerTimelineBudgetAdmits,
  type ProviderTimelineHold
} from './provider-timeline-budget'
import type { ProviderTimelineContext } from './provider-timeline-context'
import {
  decideProviderTimelineEvent,
  type ProviderTimelineDecidedEvent
} from './provider-timeline-decision'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from './provider-timeline-identity'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { ProviderTimelineRows, providerTimelineTurnRowState } from './provider-timeline-rows'
import { ProviderTimelineState } from './provider-timeline-state'
import {
  applyProviderTimelineTextClose,
  applyProviderTimelineTextDelta,
  type ProviderTimelineApplyResult,
  type ProviderTimelineTextHost
} from './provider-timeline-text-events'
import { ProviderTimelineTextStreams } from './provider-timeline-text-streams'
import {
  planProviderTimelineBarrier,
  planProviderTimelineWrites
} from './provider-timeline-transition-layout'

export type { ProviderTimelineDropRule } from './provider-timeline-decision'
export type { ProviderTimelineApplyResult } from './provider-timeline-text-events'

export type ProviderTimelineAssembler = {
  /** Provider completion must revise the host’s existing command turn. */
  beginCommand(command: StructuredAgentSessionCommandRun): void
  forgetCommand(turnId: string): void
  /** Observe only this event’s transition, excluding preliminary settlement and drops. */
  apply(event: ProviderTimelineEvent, onPublished?: () => void): ProviderTimelineApplyResult
  readonly openTurnId: string | null
  flush(): void
  /** Drops buffered text; apply session.ended first to flush it. */
  dispose(): void
}

export type ProviderTimelineAssemblerDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: AgentType
  /** Minted keys and request IDs are generation-scoped. */
  generation: string
  namespace: string
  /** Distinguish session work from subagent threads. */
  ownThread?: () => string | null
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function createProviderTimelineAssembler(
  deps: ProviderTimelineAssemblerDeps
): ProviderTimelineAssembler {
  const context: ProviderTimelineContext = {
    sessionId: deps.sessionId,
    agent: deps.agent,
    generation: deps.generation,
    rows: new ProviderTimelineRows({
      scheme: createLegacyProviderTimelineIdentityScheme({
        agent: deps.agent,
        sessionId: deps.sessionId
      }),
      generation: deps.generation,
      namespace: deps.namespace
    }),
    ...(deps.ownThread ? { ownThread: deps.ownThread } : {})
  }
  const state = new ProviderTimelineState()
  const streams = new ProviderTimelineTextStreams({
    sink: deps.sink,
    context,
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {})
  })

  const textHost = (journal: ProviderTimelineTextHost['journal']): ProviderTimelineTextHost => ({
    sink: deps.sink,
    state,
    streams,
    journal,
    admits: (hold) => admits(hold, journal)
  })

  const admits = (hold: ProviderTimelineHold, journal: ProviderTimelineTextHost['journal']) =>
    providerTimelineBudgetAdmits({ hold, state, streams, journal })

  const applyDecided = (
    event: ProviderTimelineDecidedEvent,
    journal: ProviderTimelineTextHost['journal'],
    onPublished?: () => void
  ): ProviderTimelineApplyResult => {
    const serials = state.serials()
    const decision = decideProviderTimelineEvent(
      { context, state, journal, serial: serials.next },
      event
    )
    if (decision.dropped) {
      return { admission: ADMITTED, dropped: decision.dropped }
    }
    if (decision.hold && !admits(decision.hold, journal)) {
      return { admission: PROVIDER_TIMELINE_OVER_BUDGET }
    }
    const plan = new ProviderTimelinePlan()
    planProviderTimelineBarrier({ streams, state }, plan, event, decision)
    planProviderTimelineWrites(context, plan, decision, serials.next)
    plan.onAdmitted(() => {
      decision.commit?.(state)
      serials.commit()
    })
    if (
      event.type === 'turn.open' ||
      event.type === 'session.ended' ||
      decision.ends?.current === true
    ) {
      plan.onAdmitted(() => deps.sink.setActivity?.(null))
    }
    return { admission: plan.submit(deps.sink, onPublished) }
  }

  /** Settle another writer’s ended turn first; refusal rejects the discovering event so retry repeats both. */
  const endSettledTurn = (
    journal: NonNullable<ProviderTimelineTextHost['journal']>
  ): ProviderTimelineApplyResult | null => {
    const open = state.open
    if (state.ended || !open || providerTimelineTurnRowState(journal, open.itemId) !== 'settled') {
      return null
    }
    return applyDecided({ type: 'turn.settled', turn: open }, journal)
  }

  const apply = (
    event: ProviderTimelineEvent,
    onPublished?: () => void
  ): ProviderTimelineApplyResult => {
    const journal = deps.sink.journalItems()
    const settled = journal ? endSettledTurn(journal) : null
    if (settled && !settled.admission.accepted) {
      return settled
    }
    switch (event.type) {
      case 'text.delta':
        return applyProviderTimelineTextDelta(textHost(journal), event)
      case 'text.close':
        return applyProviderTimelineTextClose(textHost(journal), event)
      case 'activity': {
        const open = state.open
        if (state.ended || !open) {
          return { admission: ADMITTED, dropped: state.ended ? 'session-ended' : 'no-turn' }
        }
        deps.sink.setActivity?.(
          event.text === null ? null : { turnId: open.turnId, text: event.text }
        )
        return { admission: ADMITTED }
      }
      case 'input.accepted':
      case 'turn.open':
      case 'turn.end':
      case 'item.open':
      case 'item.update':
      case 'item.close':
      case 'request.open':
      case 'request.withdrawn':
      case 'context.usage':
      case 'provider.frame':
      case 'session.ended':
        return applyDecided(event, journal, onPublished)
    }
  }

  return {
    forgetCommand: (turnId) => {
      if (state.open?.turnId === turnId) {
        state.endTurn(state.open)
      }
    },
    beginCommand: (command) => {
      if (state.ended || state.open || state.stopped) {
        throw new Error('Provider timeline cannot adopt a command while work is open')
      }
      const running = readAgentJournalTurn(command.running)
      if (!running || running.state !== 'running' || running.turnId !== command.turnId) {
        throw new Error('Provider timeline command is not a running host turn')
      }
      state.open = {
        identity: command.identity,
        itemId: agentJournalItemKey(command.identity),
        turnId: command.turnId,
        key: { source: 'provider', value: command.turnId },
        running
      }
    },
    apply,
    get openTurnId() {
      return state.open?.turnId ?? null
    },
    flush: () => streams.flush(),
    dispose: () => streams.dispose()
  }
}
