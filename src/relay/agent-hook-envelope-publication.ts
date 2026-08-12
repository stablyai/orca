import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_SHED_FIELDS_KEY,
  createShedSubagentsField,
  type AgentHookRelayEnvelope
} from '../shared/agent-hook-relay'
import type { RelayDispatcher } from './dispatcher'

// Why: shed the biggest, most reconstructible fields first — state/paneKey must survive or the pane
// stays stuck on its last spinner, and an over-capacity frame is now dropped rather than sent.
// Why: interactivePrompt is last on purpose — a blocking question is load-bearing (without its card
// the pane sits on `waiting` with no way to answer from web or mobile). The roster is shed earlier
// only because it is cheaper to rebuild, NOT because it is cosmetic: a missing roster blanks live
// subagent rows and unblocks pane hibernation, which is why shed fields are named on the wire —
// `restoreShedStatusFields` re-attaches the restorable ones from Orca's cached payload.
const SHED_ORDER = ['lastAssistantMessage', 'subagents', 'interactivePrompt'] as const

// Why: these envelopes are fire-and-forget state snapshots — no ack, no producer-side retry — and
// the only other delivery path is the reattach replay. A queue-full drop would otherwise leave the
// pane on a stale spinner until the SSH link cycles, so a rejected snapshot is retried briefly.
const REDELIVERY_INTERVAL_MS = 250
const MAX_REDELIVERY_ATTEMPTS = 40
// Why: a wedged link must not pin snapshots for panes that are already gone; recency-evict the rest.
const MAX_PENDING_PANES = 64

type PendingEnvelope = {
  params: Record<string, unknown>
  clientIds: readonly number[]
  /** Zero means the timer budget is exhausted and one capacity-driven attempt remains. */
  attemptsLeft: number
}

type RedeliveryState = {
  pending: Map<string, PendingEnvelope>
  timer: ReturnType<typeof setInterval> | null
}

const redeliveryByDispatcher = new WeakMap<RelayDispatcher, RedeliveryState>()
// Why: some agents submit option labels verbatim, so only presentation-only fields may shrink.
const COMPACTABLE_INTERACTIVE_PROMPT_FIELDS = new Set([
  'description',
  'detail',
  'header',
  'question',
  'summary'
])

function fitsProducerFrame(dispatcher: RelayDispatcher, params: Record<string, unknown>): boolean {
  return dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params) >= 0
}

function toNotificationParams(
  envelope: AgentHookRelayEnvelope,
  shedFields: readonly string[]
): Record<string, unknown> {
  const params = envelope as unknown as Record<string, unknown>
  return shedFields.length === 0
    ? params
    : { ...params, [AGENT_HOOK_SHED_FIELDS_KEY]: [...shedFields] }
}

function compactInteractivePromptValue(value: unknown, maxStringLength: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactInteractivePromptValue(item, maxStringLength))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'string' && COMPACTABLE_INTERACTIVE_PROMPT_FIELDS.has(key)
        ? item.slice(0, maxStringLength)
        : compactInteractivePromptValue(item, maxStringLength)
    ])
  )
}

function fitWaitingInteractivePrompt(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope,
  shedFields: readonly string[]
): AgentHookRelayEnvelope | null {
  const prompt = envelope.payload.interactivePrompt
  if (!prompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(prompt)
  } catch {
    parsed = undefined
  }
  const promptAtLimit = (limit: number): string =>
    parsed === undefined
      ? prompt.slice(0, limit)
      : JSON.stringify(compactInteractivePromptValue(parsed, limit))
  let low = 1
  let high = prompt.length
  let fitted: AgentHookRelayEnvelope | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = {
      ...envelope,
      payload: { ...envelope.payload, interactivePrompt: promptAtLimit(mid) }
    }
    if (fitsProducerFrame(dispatcher, toNotificationParams(candidate, shedFields))) {
      fitted = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return fitted
}

/** Returns the ids of the clients that rejected the frame; a rejected client is never written to. */
function publishToClients(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  clientIds: readonly number[],
  logDrop?: boolean
): number[] {
  const rejected: number[] = []
  for (const clientId of clientIds) {
    if (
      !dispatcher.publishProducerNotification(
        clientId,
        AGENT_HOOK_NOTIFICATION_METHOD,
        params,
        logDrop === undefined ? undefined : { logDrop }
      )
    ) {
      rejected.push(clientId)
    }
  }
  return rejected
}

function logUnsendableEnvelope(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  clientIds: readonly number[]
): void {
  const rejectedClientId = clientIds.find(
    (clientId) =>
      dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params, clientId) < 0
  )
  if (rejectedClientId !== undefined) {
    publishToClients(dispatcher, params, [rejectedClientId], true)
  }
}

/** Publishes an agent-hook envelope, dropping optional detail fields until the frame fits the
 *  smallest attached sink. A frame the sink queue merely has no room for is retried in the
 *  background; one that no shedding can fit is dropped. */
export function publishAgentHookEnvelope(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope
): void {
  const clientIds = dispatcher.activeClientIds()
  if (clientIds.length === 0) {
    return
  }
  // Why: a fan-out must choose one payload before it writes anything, or the first client keeps a
  // frame a smaller later client forces us to shed. A single sink writes nothing when it rejects,
  // so there the attempt itself is the measurement — one encode instead of a probe plus a publish.
  const measureBeforePublish = clientIds.length > 1
  let candidate = envelope
  const shedFields: string[] = []
  let step = 0
  for (;;) {
    const params = toNotificationParams(candidate, shedFields)
    while (step < SHED_ORDER.length && candidate.payload[SHED_ORDER[step]] === undefined) {
      step += 1
    }
    if (!measureBeforePublish || fitsProducerFrame(dispatcher, params)) {
      // A rejected intermediate probe is not a drop if a smaller envelope is delivered next.
      const rejected = publishToClients(
        dispatcher,
        params,
        clientIds,
        measureBeforePublish ? undefined : step >= SHED_ORDER.length
      )
      if (rejected.length === 0) {
        clearPendingEnvelope(dispatcher, envelope.paneKey)
        return
      }
      // Rejection is ambiguous: an over-capacity frame must shed, a full producer queue must wait.
      if (measureBeforePublish || fitsProducerFrame(dispatcher, params)) {
        setPendingEnvelope(dispatcher, envelope.paneKey, params, rejected)
        return
      }
    }
    if (step >= SHED_ORDER.length) {
      // Nothing left to shed and it still does not fit: waiting cannot make it sendable, and this
      // snapshot supersedes any pending one, which is now stale.
      if (measureBeforePublish) {
        logUnsendableEnvelope(dispatcher, params, clientIds)
      }
      clearPendingEnvelope(dispatcher, envelope.paneKey)
      return
    }
    const field = SHED_ORDER[step]
    step += 1
    if (field === 'interactivePrompt' && candidate.payload.state === 'waiting') {
      const fitted = fitWaitingInteractivePrompt(dispatcher, candidate, shedFields)
      if (fitted) {
        candidate = fitted
        continue
      }
      // A waiting snapshot without an answerable card must not reach web/mobile.
      logUnsendableEnvelope(dispatcher, params, clientIds)
      clearPendingEnvelope(dispatcher, envelope.paneKey)
      return
    }
    // Why: the hook server caches envelopes and replays them after --connect, so shedding in place
    // would permanently strip the cached copy too.
    candidate = { ...candidate, payload: { ...candidate.payload } }
    const shedField =
      field === 'subagents' ? createShedSubagentsField(candidate.payload.subagents ?? []) : field
    delete candidate.payload[field]
    shedFields.push(shedField)
  }
}

function setPendingEnvelope(
  dispatcher: RelayDispatcher,
  paneKey: string,
  params: Record<string, unknown>,
  clientIds: readonly number[]
): void {
  let state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    state = { pending: new Map(), timer: null }
    redeliveryByDispatcher.set(dispatcher, state)
    // A disposed dispatcher can never accept the retry, and pending params pin the cached payload.
    dispatcher.onDisposed(() => stopRedelivery(dispatcher))
    dispatcher.onLegacyPtyCapacity(() => runFinalCapacityPass(dispatcher))
  }
  // Latest-wins: one snapshot per pane, never a growing queue. Delete-then-set keeps Map insertion
  // order = recency so the cap below evicts the longest-idle pane.
  state.pending.delete(paneKey)
  state.pending.set(paneKey, { params, clientIds, attemptsLeft: MAX_REDELIVERY_ATTEMPTS })
  while (state.pending.size > MAX_PENDING_PANES) {
    state.pending.delete(state.pending.keys().next().value as string)
  }
  if (!state.timer) {
    const timer = setInterval(() => runRedeliveryPass(dispatcher), REDELIVERY_INTERVAL_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    state.timer = timer
  }
}

function clearPendingEnvelope(dispatcher: RelayDispatcher, paneKey: string): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state?.pending.delete(paneKey) || state.pending.size > 0) {
    return
  }
  stopRedelivery(dispatcher)
}

function stopRedelivery(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  state.pending.clear()
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

function stopRedeliveryTimer(state: RedeliveryState): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

function runRedeliveryPass(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  const active = new Set(dispatcher.activeClientIds())
  for (const [paneKey, pending] of Array.from(state.pending)) {
    if (pending.attemptsLeft <= 0) {
      continue
    }
    // A client that detached gets caught up by the reattach replay, so stop tracking it.
    const targets = pending.clientIds.filter((clientId) => active.has(clientId))
    const rejected =
      targets.length === 0 ? [] : publishToClients(dispatcher, pending.params, targets)
    pending.attemptsLeft -= 1
    if (rejected.length === 0) {
      state.pending.delete(paneKey)
      continue
    }
    pending.clientIds = rejected
  }
  if (state.pending.size === 0) {
    stopRedelivery(dispatcher)
  } else if (Array.from(state.pending.values()).every((pending) => pending.attemptsLeft <= 0)) {
    stopRedeliveryTimer(state)
  }
}

function runFinalCapacityPass(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  const active = new Set(dispatcher.activeClientIds())
  for (const [paneKey, pending] of Array.from(state.pending)) {
    if (pending.attemptsLeft > 0) {
      continue
    }
    // Delete before publishing because a synchronous sink settlement emits capacity reentrantly.
    state.pending.delete(paneKey)
    const targets = pending.clientIds.filter((clientId) => active.has(clientId))
    if (targets.length > 0) {
      publishToClients(dispatcher, pending.params, targets)
    }
  }
  if (state.pending.size === 0) {
    stopRedelivery(dispatcher)
  }
}
