// Adapters translate and retry refused events; admission alone advances assembler state.
// The writer resolves each write at its position, preserving other writers’ answers and Stops.
// Each provider child gets a fresh assembler and generation.

import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { StructuredAgentSessionCommandRun } from '../agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionDeltaCoalescerDeps } from '../agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ProviderTimelineContext } from './provider-timeline-context'
import {
  decideProviderTimelineEvent,
  type ProviderTimelineDecidedEvent,
  type ProviderTimelineDecision
} from './provider-timeline-decision'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from './provider-timeline-identity'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { ProviderTimelineRows, type ProviderTimelineTurnRef } from './provider-timeline-rows'
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

  const textHost: ProviderTimelineTextHost = { sink: deps.sink, state, streams }
  /** Another writer settled this open turn; its closure retries until admitted. */
  let settledByOther: ProviderTimelineTurnRef | null = null

  const applyDecided = (
    event: ProviderTimelineDecidedEvent,
    onPublished?: () => void
  ): ProviderTimelineApplyResult => {
    const serials = state.serials()
    const decision = decideProviderTimelineEvent({ context, state, serial: serials.next }, event)
    if (decision.dropped) {
      return { admission: ADMITTED, dropped: decision.dropped }
    }
    // Observers see only events whose own writes the writer accepted.
    let refused = false
    const writes = decision.writes?.map(
      (write): NonNullable<ProviderTimelineDecision['writes']>[number] => ({
        ...write,
        onResolved: (outcome) => {
          refused ||= outcome.kind === 'dropped'
          write.onResolved?.(outcome)
        }
      })
    )
    const observed = onPublished && (() => !refused && onPublished())
    const plan = new ProviderTimelinePlan()
    planProviderTimelineBarrier({ streams, state }, plan, event, decision)
    planProviderTimelineWrites(
      context,
      plan,
      { ...decision, ...(writes ? { writes } : {}) },
      serials.next
    )
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
    return { admission: plan.submit(deps.sink, observed) }
  }

  /** Close another writer's settled turn first; refusal rejects the next event so its retry repeats both. */
  const endSettledTurn = (): ProviderTimelineApplyResult | null => {
    const open = state.open
    if (!settledByOther || state.ended || open?.itemId !== settledByOther.itemId) {
      settledByOther = null
      return null
    }
    const settled = applyDecided({ type: 'turn.settled', turn: open })
    if (settled.admission.accepted) {
      settledByOther = null
    }
    return settled
  }

  const releaseSettledTurns = deps.sink.observeSettledTurns?.((turnItemIds) => {
    const open = state.open
    if (state.ended || !open || !turnItemIds.includes(open.itemId)) {
      return
    }
    settledByOther = open
    // Activity clears now even if the closure must wait for queue capacity.
    deps.sink.setActivity?.(null)
    endSettledTurn()
  })

  const apply = (
    event: ProviderTimelineEvent,
    onPublished?: () => void
  ): ProviderTimelineApplyResult => {
    const settled = endSettledTurn()
    if (settled && !settled.admission.accepted) {
      return settled
    }
    switch (event.type) {
      case 'text.delta':
        return applyProviderTimelineTextDelta(textHost, event)
      case 'text.close':
        return applyProviderTimelineTextClose(textHost, event)
      case 'activity': {
        const open = state.open
        if (state.ended || !open) {
          return { admission: ADMITTED, dropped: state.ended ? 'session-ended' : 'no-turn' }
        }
        if (settledByOther?.itemId === open.itemId) {
          return { admission: ADMITTED, dropped: 'turn-settled' }
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
        return applyDecided(event, onPublished)
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
    flush: () => {
      endSettledTurn()
      streams.flush()
    },
    dispose: () => {
      releaseSettledTurns?.()
      streams.dispose()
    }
  }
}
