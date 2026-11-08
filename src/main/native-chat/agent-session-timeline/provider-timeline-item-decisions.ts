import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import { requiresTerminalSettlement } from '../agent-session-journal/item-lifecycle/journal-terminal-settlement'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import { unhandledProviderFrameJournalItem } from '../agent-session-wire/providers/unhandled-provider-frame'
import { providerTimelinePlacement } from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput
} from './provider-timeline-decision'
import { providerKey, providerTimelineTurnRowState, turnOf } from './provider-timeline-rows'
import type { ProviderTimelineRequestBody } from './provider-timeline-event'
import type { ProviderTimelineOpenItem } from './provider-timeline-state'

function pendingPrompt(body: AgentJournalItemBody | null): body is ProviderTimelineRequestBody {
  return (
    (body?.kind === 'approval' || body?.kind === 'question') && body.resolution.state === 'pending'
  )
}

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
  const opened: ProviderTimelineOpenItem = { kind: 'item', row, turnItemId: placed }
  return {
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, event.body),
        lifecycle: change !== 'update',
        options: { ...event.producer, turnScope: scope },
        resolution: { kind: 'guarded-item', identity: row.identity, body: event.body, change },
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
  const { state, journal, context } = input
  const key = requestKey(event.request)
  if (state.items.has(key) && !(journal && state.settledInJournal(key, journal))) {
    return { dropped: 'request-duplicate' }
  }
  const scope = providerTimelinePlacement(context, state, event.join)
  const turn = turnOf(scope)
  const opened: ProviderTimelineOpenItem = {
    kind: 'request',
    row: null,
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
        resolve: (at) => {
          // Reused request IDs need new incarnations; never overwrite existing rows.
          const row = context.rows.nextRequest(event.request, at)
          opened.row = row
          // A live request outliving its turn still needs its card.
          if (
            turn !== null &&
            !event.outlivesTurn &&
            providerTimelineTurnRowState(at, turn) === 'settled'
          ) {
            return null
          }
          return { identity: row.identity, body: event.body }
        }
      }
    ],
    commit: (next) => next.items.set(key, opened)
  }
}

export function decideWithdrawal(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'request.withdrawn' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const key = requestKey(event.request)
  const entry = state.items.get(key)
  const opened = entry?.kind === 'request' ? entry : null
  // Released requests may still have their newest incarnation in the journal.
  if (!opened && journal && !context.rows.heldRequest(event.request, journal)) {
    return { dropped: 'request-unknown' }
  }
  return {
    settle: {
      what: 'request-withdrawn',
      resolve: (at) => {
        // Resolve after request-open; preserve client answers or turn settlement that landed first.
        const row = opened ? opened.row : context.rows.heldRequest(event.request, at)
        const held = row ? at.item(row.itemId) : null
        const cancelled =
          held && pendingPrompt(held.body) ? cancelledJournalPromptBody(held.body) : null
        if (!row || !held || !cancelled) {
          return []
        }
        return [
          {
            kind: 'item',
            identity: row.identity,
            body: cancelled,
            turnScope: held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
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
        resolution: { kind: 'literal', identity: row.identity, body: frame.body }
      }
    ]
  }
}
