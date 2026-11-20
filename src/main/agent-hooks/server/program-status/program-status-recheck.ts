import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import { markAntigravityDoneRetried } from './hook-precedence'
import { isAgentStatusHeldOpenByChildWork } from '../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import type { PaneTimers } from './pane-timers'
import type { HookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import {
  hasShedSubagentsField,
  type AgentHookSource
} from '../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import {
  antigravityHelpersSettled,
  getOrCreateAntigravityPaneState
} from '../../../../shared/agent-hook-listener/providers/antigravity/antigravity-pane-state'

function antigravityTurn(row: AgentHookEventPayload | undefined) {
  return row
    ? {
        owner: row.hostTurn?.owner,
        key: row.hostTurn?.currentTurnKey,
        leadStartedAt: row.payload.mainAgent?.stateStartedAt,
        sessionId: row.providerSession?.id,
        launchToken: row.launchToken,
        connectionId: row.connectionId,
        worktreeId: row.worktreeId
      }
    : undefined
}

type AntigravityTurn = NonNullable<ReturnType<typeof antigravityTurn>>

function inAntigravityTurn(row: AgentHookEventPayload, turn: AntigravityTurn): boolean {
  return (
    row.payload.agentType === 'antigravity' &&
    row.hostTurn?.owner === turn.owner &&
    row.hostTurn?.currentTurnKey === turn.key &&
    row.providerSession?.id === turn.sessionId &&
    row.launchToken === turn.launchToken &&
    row.connectionId === turn.connectionId &&
    row.worktreeId === turn.worktreeId
  )
}

function sameAntigravityTurn(row: AgentHookEventPayload, turn: AntigravityTurn): boolean {
  return (
    inAntigravityTurn(row, turn) &&
    row.payload.mainAgent?.state === 'done' &&
    row.payload.mainAgent.stateStartedAt === turn.leadStartedAt
  )
}

/** Re-offer a yielding OSC 7501 report after delayMs, only against the hook observation it yielded to. */
export function deferProgramStatusRecheck<E extends { paneKey: string; tabId?: string }>(input: {
  rechecks: PaneTimers
  rows: ReadonlyMap<string, AgentHookEventPayload>
  paneKey: string
  yieldedTo: number | undefined
  delayMs: number | undefined
  preserveAntigravityDone?: boolean
  antigravityDone?: boolean
  event: E
  reoffer: (event: E) => void
}): void {
  const { yieldedTo, delayMs, event } = input
  if (yieldedTo === undefined || (delayMs === undefined && !input.preserveAntigravityDone)) {
    input.rechecks.cancel(input.paneKey)
    return
  }
  const turn = input.preserveAntigravityDone
    ? antigravityTurn(input.rows.get(input.paneKey))
    : undefined
  // agy's done can beat the proof of the subagent its busy Stop waits on, so roster and model polls
  // and that subagent's hold carry it; only a root hook showing new activity replaces it.
  const doneTurn =
    input.antigravityDone && !turn ? antigravityTurn(input.rows.get(input.paneKey)) : undefined
  const run = (currentPaneKey: string): void => {
    const row = input.rows.get(currentPaneKey)
    if (
      row &&
      row.providerSessionOnly !== true &&
      'receivedAt' in row &&
      (turn
        ? sameAntigravityTurn(row, turn)
        : row.receivedAt === yieldedTo ||
          (doneTurn !== undefined &&
            inAntigravityTurn(row, doneTurn) &&
            (row.hookEventName === undefined ||
              (row.payload.mainAgent?.state === 'done' &&
                isAgentStatusHeldOpenByChildWork(row.payload)))))
    ) {
      const tabId = parsePaneKey(currentPaneKey)?.tabId ?? event.tabId
      input.reoffer(markAntigravityDoneRetried({ ...event, paneKey: currentPaneKey, tabId }))
    }
  }
  if (delayMs === undefined) {
    input.rechecks.park(input.paneKey, run)
  } else {
    input.rechecks.defer(input.paneKey, delayMs + 1, run, doneTurn !== undefined)
  }
}

export function wakeAntigravityDone(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  rechecks: PaneTimers
): void {
  if (source !== 'antigravity') {
    return
  }
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (pane?.helpersIdleAt !== undefined && antigravityHelpersSettled(pane)) {
    rechecks.wake(paneKey)
  }
}

export function discardAntigravityDone(
  state: HookListenerState,
  rechecks: PaneTimers,
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  applied: AgentHookEventPayload | undefined
): void {
  // A rejected event returns the unchanged row, and a poll reports no new root activity, so the agy done stays.
  if (
    applied !== previous &&
    applied?.payload.agentType === 'antigravity' &&
    (incoming.hasExplicitPrompt ||
      applied.payload.state === 'done' ||
      (incoming.hookEventName !== undefined && applied.payload.mainAgent?.state !== 'done'))
  ) {
    rechecks.cancel(applied.paneKey)
    if (applied.connectionId && applied.payload.state === 'done') {
      state.antigravityChildWorkByPaneKey.delete(applied.paneKey)
    }
  }
}

export function reconcileRelayedAntigravityDone(
  state: HookListenerState,
  rechecks: PaneTimers,
  previous: AgentHookEventPayload | undefined,
  applied: AgentHookEventPayload | undefined,
  shedFields?: unknown
): void {
  if (
    !applied?.connectionId ||
    applied.payload.agentType !== 'antigravity' ||
    applied === previous
  ) {
    return
  }
  if (applied.payload.state === 'done') {
    state.antigravityChildWorkByPaneKey.delete(applied.paneKey)
    return
  }
  const pane = getOrCreateAntigravityPaneState(state, applied.paneKey)
  const sameTurn =
    previous?.connectionId === applied.connectionId &&
    previous.providerSession?.id === applied.providerSession?.id &&
    previous.launchToken === applied.launchToken &&
    previous.payload.mainAgent?.stateStartedAt === applied.payload.mainAgent?.stateStartedAt &&
    previous.hostTurn?.owner === applied.hostTurn?.owner &&
    previous.hostTurn?.currentTurnKey === applied.hostTurn?.currentTurnKey
  if (!sameTurn || applied.hasExplicitPrompt || applied.payload.mainAgent?.state !== 'done') {
    pane.helpersIdleAt = undefined
  }
  const now = Date.now()
  if (!sameTurn || applied.hookEventName !== undefined || pane.leadObservedAt === undefined) {
    pane.leadObservedAt = now
  }
  const heldBefore =
    previous?.payload.subagents?.length ||
    previous?.payload.antigravitySpawnPending ||
    pane.relayRosterShed
  pane.relayRosterShed =
    hasShedSubagentsField(shedFields) && !applied.payload.subagents ? true : undefined
  // A pending spawn holds the run; its settling ends child work like a subagent leaving the row.
  if (
    applied.payload.subagents?.length ||
    applied.payload.antigravitySpawnPending ||
    pane.relayRosterShed
  ) {
    pane.helpersIdleAt = undefined
  } else if (sameTurn && heldBefore && applied.payload.mainAgent?.state === 'done') {
    pane.helpersIdleAt = now
  }
  if (pane.helpersIdleAt !== undefined) {
    rechecks.wake(applied.paneKey)
  }
}
