import { requiresTerminalSettlement } from '../agent-session-journal/item-lifecycle/journal-terminal-settlement'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import { unhandledProviderFrameJournalItem } from '../agent-session-wire/providers/unhandled-provider-frame'
import {
  providerTimelinePlacement,
  providerTimelineRequest,
  providerTimelineScopeItemIds
} from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput
} from './provider-timeline-decision'
import { providerKey, turnOf } from './provider-timeline-rows'
import type { ProviderTimelineOpenItem } from './provider-timeline-state'

export function decideItem(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'item.open' | 'item.update' | 'item.close' }>
): ProviderTimelineDecision {
  const { state, context } = input
  const change =
    event.type === 'item.open' ? 'open' : event.type === 'item.update' ? 'update' : 'close'
  const row = context.rows.item('item', providerKey(event.item), event.join?.thread ?? null)
  const key = row.itemId
  const closed = state.closedItems.has(key)
  const scope = providerTimelinePlacement(context, state, event.join)
  const placed = turnOf(scope)
  if (
    closed &&
    (change === 'close' || (change === 'update' && requiresTerminalSettlement(event.body)))
  ) {
    return { dropped: 'item-settled' }
  }
  const obligation = change !== 'close' && requiresTerminalSettlement(event.body)
  const opened: ProviderTimelineOpenItem = { kind: 'item', turnItemId: placed }
  return {
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, event.body),
        lifecycle: change !== 'update',
        options: { ...event.producer, turnScope: scope },
        resolution: {
          kind:
            event.type === 'item.update' && event.lossWarning ? 'acp-loss-warning' : 'guarded-item',
          identity: row.identity,
          body: event.body,
          change,
          scopeItemIds: providerTimelineScopeItemIds(context, event.join)
        },
        onResolved: (outcome) => {
          if (outcome.kind === 'dropped' && state.items.get(key) === opened) {
            state.close(key, placed)
          }
        }
      }
    ],
    ...(change === 'close' ? { closes: key } : {}),
    commit: (next) => {
      if (change === 'close') {
        next.close(key, placed)
      } else if (obligation) {
        next.closedItems.delete(key)
        next.items.set(key, opened)
      } else if (change === 'open' || !next.closedItems.has(key)) {
        next.closedItems.delete(key)
        next.items.delete(key)
      }
    }
  }
}

const requestKey = (request: string) => `request:${request}`

export function decideRequest(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'request.open' }>
): ProviderTimelineDecision {
  const { state, context } = input
  const key = requestKey(event.request)
  // The writer drops a duplicate while the earlier incarnation is pending; an answered one is reused.
  const previous = state.items.get(key)
  const scope = providerTimelinePlacement(context, state, event.join)
  const turn = turnOf(scope)
  const opened: ProviderTimelineOpenItem = {
    kind: 'request',
    request: event.request,
    turnItemId: turn,
    ...(event.outlivesTurn ? { outlivesTurn: true as const } : {})
  }
  return {
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(
          context.rows.widestRequest(event.request).identity,
          event.body
        ),
        lifecycle: true,
        options: { ...event.producer, turnScope: scope, lifecycle: true },
        resolution: {
          kind: 'request-open',
          request: providerTimelineRequest(context, event.request),
          body: event.body,
          turnItemId: turn,
          scopeItemIds: providerTimelineScopeItemIds(context, event.join),
          ...(event.outlivesTurn ? { outlivesTurn: true as const } : {})
        },
        onResolved: (outcome) => {
          if (outcome.kind === 'dropped' && state.items.get(key) === opened) {
            if (previous) {
              state.items.set(key, previous)
            } else {
              state.items.delete(key)
            }
          }
        }
      }
    ],
    commit: (next) => next.items.set(key, opened)
  }
}

/** The writer withdraws the newest incarnation only while it is still pending. */
export function decideWithdrawal(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'request.withdrawn' }>
): ProviderTimelineDecision {
  const key = requestKey(event.request)
  return {
    settle: {
      what: 'request-withdrawn',
      resolution: {
        kind: 'request-withdrawn',
        request: providerTimelineRequest(input.context, event.request)
      }
    },
    commit: (next) => next.items.delete(key)
  }
}

export function decideFrame(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'provider.frame' }>
): ProviderTimelineDecision {
  const { state, context } = input
  const frame = unhandledProviderFrameJournalItem(context.agent, event.frameKind, event.payload)
  if (!frame) {
    return {}
  }
  const row = context.rows.item(
    'frame',
    context.rows.minted('f', input.serial()),
    event.join?.thread ?? null
  )
  return {
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, frame.body),
        lifecycle: false,
        options: { turnScope: providerTimelinePlacement(context, state, event.join) },
        resolution: {
          kind: 'literal',
          identity: row.identity,
          body: frame.body,
          scopeItemIds: providerTimelineScopeItemIds(context, event.join)
        }
      }
    ]
  }
}
