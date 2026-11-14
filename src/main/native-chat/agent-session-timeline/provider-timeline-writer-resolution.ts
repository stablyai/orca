// The writer decides request incarnations, turn eligibility and settlement at its own write position.

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { cancelledJournalPromptBody } from '../agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import type {
  JournalLifecycleIdentityMutationInput,
  JournalLifecycleMutationInput
} from '../agent-session-journal/writing/journal-lifecycle-mutation'
import type { JournalTimelineView } from '../agent-session-journal/writing/journal-timeline-view'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'
import { createLegacyProviderTimelineIdentityScheme } from './provider-timeline-identity'
import {
  providerTimelineSettlement,
  runningProviderTimelineTurns,
  type ProviderTimelineSettlementScope,
  type ProviderTimelineTurnEnd
} from './provider-timeline-settlement'

/** Stable request coordinates; the writer spells and probes the incarnation. */
export type ProviderTimelineRequest = {
  agent: AgentType
  sessionId: string
  generation: string
  key: string
}

export type ProviderTimelineWrittenItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

export type ProviderTimelineTurnVerdict =
  | { kind: 'resolved'; item: ProviderTimelineWrittenItem }
  | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }
  | { kind: 'dropped' }

export type ProviderTimelineSettlementResolution =
  | {
      kind: 'timeline-settlement'
      scope: ProviderTimelineSettlementScope
      ending?: {
        turns: readonly AgentJournalItemIdentity[] | 'running'
        end: ProviderTimelineTurnEnd
        lostAt?: number
      }
      /** Live requests that outlive the turn end only by their own answer or withdrawal. */
      keep: readonly ProviderTimelineRequest[]
    }
  | { kind: 'request-withdrawn'; request: ProviderTimelineRequest }
  /** Lifecycle writers own lifecycle fields; preserve the rest of each turn row. */
  | {
      kind: 'turn-revisions'
      mutations: readonly JournalLifecycleIdentityMutationInput[]
      keptBytes: number
    }

type View = JournalTimelineView

function requestRow(request: ProviderTimelineRequest, incarnation: number) {
  const identity = createLegacyProviderTimelineIdentityScheme(request).request({
    generation: request.generation,
    key: request.key,
    incarnation
  })
  return { identity, itemId: agentJournalItemKey(identity) }
}

/** Probe for the first absent incarnation; reused request IDs never overwrite rows. */
export function providerTimelineRequestRows(
  request: ProviderTimelineRequest,
  itemBody: View['itemBody']
): { held: ReturnType<typeof requestRow> | null; next: ReturnType<typeof requestRow> } {
  let held = 0
  while (itemBody(requestRow(request, held + 1).itemId) !== null) {
    held += 1
  }
  return {
    held: held === 0 ? null : requestRow(request, held),
    next: requestRow(request, held + 1)
  }
}

function settled(view: View, turnItemId: string): boolean {
  const row = readAgentJournalTurn(view.itemBody(turnItemId) ?? undefined)
  return row !== null && row.state !== 'running'
}

/** A still-pending newest incarnation makes the open a duplicate; an answered one is reused under a new incarnation. */
export function resolveProviderTimelineRequestOpen(
  view: View,
  resolution: {
    request: ProviderTimelineRequest
    body: AgentJournalItemBody
    turnItemId: string | null
    outlivesTurn?: true
  }
): ProviderTimelineTurnVerdict {
  const { turnItemId } = resolution
  // A live request outliving its turn still needs its card.
  if (turnItemId !== null && !resolution.outlivesTurn && settled(view, turnItemId)) {
    return { kind: 'dropped', reason: 'turn-settled', turnItemId }
  }
  const { held, next } = providerTimelineRequestRows(resolution.request, view.itemBody)
  if (held && pendingPrompt(view.itemBody(held.itemId))) {
    return { kind: 'dropped' }
  }
  return { kind: 'resolved', item: { identity: next.identity, body: resolution.body } }
}

/** Never regress an existing turn to running. */
export function resolveProviderTimelineTurnOpen(
  view: View,
  item: ProviderTimelineWrittenItem
): ProviderTimelineTurnVerdict {
  const turnItemId = agentJournalItemKey(item.identity)
  if (view.itemBody(turnItemId) === null) {
    return { kind: 'resolved', item }
  }
  return settled(view, turnItemId)
    ? { kind: 'dropped', reason: 'turn-settled', turnItemId }
    : { kind: 'dropped' }
}

/** Set openers only on running, unclaimed turns; preserve all other journal fields. */
export function resolveProviderTimelineTurnOpener(
  view: View,
  identity: AgentJournalItemIdentity,
  message: { userItemId: string; requestedAt: number }
): ProviderTimelineWrittenItem | null {
  const itemId = agentJournalItemKey(identity)
  const row = readAgentJournalTurn(view.itemBody(itemId) ?? undefined)
  if (row?.state !== 'running' || row.userItemId !== itemId) {
    return null
  }
  const target = { identity }
  const write = {
    lifecycle: agentJournalTurnBody({ ...row, ...message }),
    onlyWhileRunning: true as const
  }
  return resolveAgentJournalTurnRowWrite(
    view,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}

function pendingPrompt(body: AgentJournalItemBody | null) {
  return (
    (body?.kind === 'approval' || body?.kind === 'question') && body.resolution.state === 'pending'
  )
}

export function resolveProviderTimelineSettlement(
  view: View,
  resolution: ProviderTimelineSettlementResolution
): readonly JournalLifecycleMutationInput[] {
  if (resolution.kind === 'turn-revisions') {
    return resolution.mutations.map((mutation) =>
      mutation.kind === 'item' && mutation.body.kind === 'turn'
        ? {
            ...mutation,
            body:
              resolveAgentJournalTurnRowWrite(
                view,
                { identity: mutation.identity },
                { lifecycle: mutation.body },
                estimateStructuredAgentSessionItemBytes(mutation.identity, mutation.body) +
                  resolution.keptBytes
              )?.body ?? mutation.body
          }
        : mutation
    )
  }
  if (resolution.kind === 'request-withdrawn') {
    // Preserve client answers or turn settlement that landed first.
    const { held } = providerTimelineRequestRows(resolution.request, view.itemBody)
    const item = held ? view.item(held.itemId) : null
    if (!held || !item || !pendingPrompt(item.body)) {
      return []
    }
    const cancelled = cancelledJournalPromptBody(item.body)
    return cancelled
      ? [
          {
            kind: 'item',
            identity: held.identity,
            body: cancelled,
            turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      : []
  }
  const { ending } = resolution
  const keep = new Set<string>()
  for (const request of resolution.keep) {
    const { held } = providerTimelineRequestRows(request, view.itemBody)
    if (held) {
      keep.add(held.itemId)
    }
  }
  return providerTimelineSettlement(
    view,
    resolution.scope,
    ending && {
      turns:
        ending.turns === 'running'
          ? runningProviderTimelineTurns(view)
          : ending.turns.map((identity) => ({ identity, itemId: agentJournalItemKey(identity) })),
      end: ending.end,
      ...(ending.lostAt !== undefined ? { lostAt: ending.lostAt } : {})
    },
    keep
  )
}
