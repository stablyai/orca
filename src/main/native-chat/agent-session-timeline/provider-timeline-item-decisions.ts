// What item, request and frame events do: admitted on the state, written against the journal.

import { isDeepStrictEqual } from 'node:util'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'
import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import { unhandledProviderFrameJournalItem } from '../agent-session-wire/unhandled-provider-frame'
import { relightsProviderTimelineBackgroundTask } from './provider-timeline-background-tasks'
import { providerTimelineEntryBytes, providerTimelinePlacement } from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput
} from './provider-timeline-decision'
import {
  providerKey,
  providerTimelineTurnRowState,
  turnOf,
  type ProviderTimelineRowId
} from './provider-timeline-rows'
import type { ProviderTimelineRequestBody } from './provider-timeline-event'
import type { ProviderTimelineOpenItem } from './provider-timeline-state'

type Journal = StructuredAgentSessionTransitionJournal
type ItemChange = 'open' | 'update' | 'close'

function settledTool(body: AgentJournalItemBody | null): boolean {
  return body?.kind === 'tool-call' && body.state !== 'running'
}

function pendingPrompt(body: AgentJournalItemBody | null): body is ProviderTimelineRequestBody {
  return (
    (body?.kind === 'approval' || body?.kind === 'question') && body.resolution.state === 'pending'
  )
}

/** Whether the row the journal holds refuses this write: a settled tool keeps its first terminal
 *  body (whoever settled it, the sweep included), a settled background task is never relit, and a
 *  turn that is over takes no new work that waits on a settlement. Work it still holds open (a
 *  person's Stop leaves the provider's running tools) takes the provider's updates until settled. */
function refusesItemWrite(
  journal: Journal,
  row: ProviderTimelineRowId,
  change: ItemChange,
  body: AgentJournalItemBody,
  placed: string | null
): boolean {
  const held = journal.item(row.itemId)
  const turn = held ? turnOf(held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : placed
  if (
    held &&
    settledTool(held.body) &&
    (change === 'close' || !isDeepStrictEqual(held.body, body))
  ) {
    return true
  }
  if (relightsProviderTimelineBackgroundTask(held?.body ?? null, body)) {
    return true
  }
  return (
    requiresTerminalSettlement(body) &&
    !(held && requiresTerminalSettlement(held.body)) &&
    turn !== null &&
    providerTimelineTurnRowState(journal, turn) === 'settled'
  )
}

export function decideItem(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'item.open' | 'item.update' | 'item.close' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const change =
    event.type === 'item.open' ? 'open' : event.type === 'item.update' ? 'update' : 'close'
  const row = context.rows.item('item', providerKey(event.item), event.join?.thread ?? null)
  const key = row.itemId
  const closed = state.items.get(key)?.closed === true
  const scope = providerTimelinePlacement(context, state, event.join)
  const placed = turnOf(scope)
  if (
    (closed &&
      (change === 'close' || (change === 'update' && requiresTerminalSettlement(event.body)))) ||
    (journal && refusesItemWrite(journal, row, change, event.body, placed))
  ) {
    return { dropped: 'item-settled' }
  }
  const obligation = change !== 'close' && requiresTerminalSettlement(event.body)
  const bytes = providerTimelineEntryBytes({
    key: event.item,
    join: event.join,
    body: event.body,
    producer: event.producer
  })
  return {
    ...(obligation ? { hold: { key, bytes } } : {}),
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, event.body),
        lifecycle: change !== 'update',
        options: { ...event.producer, turnScope: scope },
        resolve: (at) =>
          refusesItemWrite(at, row, change, event.body, placed)
            ? null
            : { identity: row.identity, body: event.body }
      }
    ],
    ...(change === 'close' ? { closes: key } : {}),
    commit: (next) => {
      if (change === 'close') {
        next.close(key, placed)
      } else if (obligation) {
        next.items.set(key, { kind: 'item', row, turnItemId: placed, bytes, closed: false })
      } else if (change === 'open' || next.items.get(key)?.closed !== true) {
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
  // Pending here, unless a client's answer already settled it in the journal.
  if (state.items.has(key) && !(journal && state.settledInJournal(key, journal))) {
    return { dropped: 'request-duplicate' }
  }
  const scope = providerTimelinePlacement(context, state, event.join)
  const turn = turnOf(scope)
  const bytes = providerTimelineEntryBytes({
    key: event.request,
    join: event.join,
    body: event.body,
    producer: event.producer
  })
  const opened: ProviderTimelineOpenItem = {
    kind: 'request',
    row: null,
    turnItemId: turn,
    bytes,
    closed: false
  }
  return {
    hold: { key, bytes },
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(
          context.rows.widestRequest(event.request).identity,
          event.body
        ),
        lifecycle: true,
        options: { ...event.producer, turnScope: scope, lifecycle: true },
        resolve: (at) => {
          // A reused id takes the next incarnation; a row already there is never overwritten.
          const row = context.rows.nextRequest(event.request, at)
          opened.row = row
          // A turn another writer ended while the open was queued asks nothing more.
          if (turn !== null && providerTimelineTurnRowState(at, turn) === 'settled') {
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
  // One its turn's end already let go is still the journal's newest row under its id.
  if (!opened && journal && !context.rows.heldRequest(event.request, journal)) {
    return { dropped: 'request-unknown' }
  }
  return {
    settle: {
      what: 'request-withdrawn',
      resolve: (at) => {
        // The open ran first and named its row. Only while it is pending: a client's answer, or
        // the settlement of its turn, that landed first stands.
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
  const write = { identity: row.identity, body: frame.body }
  return {
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, frame.body),
        lifecycle: false,
        options: { turnScope: providerTimelinePlacement(context, state, event.join) },
        resolve: () => write
      }
    ]
  }
}
