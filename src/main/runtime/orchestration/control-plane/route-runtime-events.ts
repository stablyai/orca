import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { DispatchContextRow } from '../types'
import { createHash } from 'node:crypto'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import type { ControlPlaneDatabaseHandle } from './control-plane-store'
import type { RouteIdentity } from './route-registry-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

/** Blocker 8 — the runtime-owned evidence a route needs to become certified.
 *
 *  Three of the ten evidence kinds had no production writer at all, so no route
 *  could ever reach PASS and the automatic reviewer was unreachable. None of
 *  them needed new telemetry: Orca already receives every fact, it simply never
 *  wrote down the two that are decisions.
 *
 *    effective identity   the PROVIDER reports its own model through its own
 *                         hook. Bound to this Dispatch's exact terminal, pane
 *                         and process incarnation, and only counted when the
 *                         report is newer than the dispatch itself — a status
 *                         left behind by a previous process on the same pane
 *                         describes that process, not this one.
 *    PreTool acceptance   an EXPLICIT accepted decision from the policy path.
 *                         A PreTool event only proves a tool was seen; the hook
 *                         can fire before any allow/deny exists, so treating the
 *                         event as the decision is the proxy-field gaming this
 *                         package exists to remove. No recorded decision means
 *                         no acceptance, and certification fails closed.
 *    safe-launch          an explicit admission, persisted at the moment the
 *                         decision is made. A launch token proves a pane was
 *                         prepared, never that admission was granted.
 */

export const ROUTE_RUNTIME_EVENT_KINDS = ['safe_launch', 'pretool'] as const
export type RouteRuntimeEventKind = (typeof ROUTE_RUNTIME_EVENT_KINDS)[number]

function recordDecision(
  handle: ControlPlaneDatabaseHandle,
  args: { dispatchId: string; kind: RouteRuntimeEventKind; decision: string; observedAt: string }
): void {
  handle.db
    .prepare(
      `INSERT INTO control_plane_route_runtime_events
         (dispatch_id, kind, decision, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dispatch_id, kind) DO NOTHING`
    )
    .run(args.dispatchId, args.kind, args.decision, args.observedAt)
}

function readDecision(
  handle: ControlPlaneDatabaseHandle,
  dispatchId: string,
  kind: RouteRuntimeEventKind
): string | null {
  const row = handle.db
    .prepare(
      `SELECT decision FROM control_plane_route_runtime_events
       WHERE dispatch_id = ? AND kind = ?`
    )
    .get(dispatchId, kind) as { decision: string } | undefined
  return row?.decision ?? null
}

export function recordSafeLaunchAdmission(
  handle: ControlPlaneDatabaseHandle,
  args: { dispatchId: string; decision: 'admitted' | 'refused'; observedAt: string }
): void {
  recordDecision(handle, { ...args, kind: 'safe_launch' })
}

/** Written ONLY by the authoritative PreTool policy path, at the point a decision
 *  is actually reached. Nothing infers this from a hook event. */
export function recordPretoolDecision(
  handle: ControlPlaneDatabaseHandle,
  args: { dispatchId: string; decision: 'accepted' | 'denied'; observedAt: string }
): void {
  recordDecision(handle, { ...args, kind: 'pretool' })
}

export function readPretoolDecision(
  handle: ControlPlaneDatabaseHandle,
  dispatchId: string
): 'accepted' | 'denied' | null {
  const decision = readDecision(handle, dispatchId, 'pretool')
  return decision === 'accepted' || decision === 'denied' ? decision : null
}

export function readSafeLaunchAdmission(
  handle: ControlPlaneDatabaseHandle,
  dispatchId: string
): 'admitted' | 'refused' | null {
  const decision = readDecision(handle, dispatchId, 'safe_launch')
  return decision === 'admitted' || decision === 'refused' ? decision : null
}

/** The agent-status record Orca keeps for THIS Dispatch's exact session.
 *
 *  Pane alone is not enough: a pane outlives the process in it, so a status left
 *  by a previous incarnation describes that process rather than this one. The
 *  terminal, the pane, the process incarnation and a report newer than the
 *  dispatch itself all have to line up. */
function statusForDispatch(
  dispatch: DispatchContextRow,
  snapshot: readonly AgentStatusIpcPayload[]
): AgentStatusIpcPayload | undefined {
  const dispatchedAtMs = Date.parse(exposeUtcTimestamp(dispatch.dispatched_at) ?? '')
  return snapshot.find((entry) => {
    if (entry.paneKey !== dispatch.assignee_pane_key) {
      return false
    }
    if (
      dispatch.assignee_handle &&
      entry.terminalHandle &&
      entry.terminalHandle !== dispatch.assignee_handle
    ) {
      return false
    }
    // The launch token is this session's identity: a report carrying a different
    // one came from a different launch in the same pane.
    if (dispatch.launch_token_hash) {
      if (!entry.launchToken) {
        return false
      }
      if (
        createHash('sha256').update(entry.launchToken).digest('hex') !== dispatch.launch_token_hash
      ) {
        return false
      }
    }
    // And it has to be newer than the Dispatch, so a status left behind before
    // this Dispatch existed cannot describe it.
    return !Number.isFinite(dispatchedAtMs) || entry.receivedAt >= dispatchedAtMs
  })
}

/** The model the PROVIDER reported through its own hook, never the one that was
 *  requested. Null when it has not reported one, so certification fails closed
 *  rather than certifying the request back to itself. */
export function observedIdentityFromAgentStatus(
  dispatch: DispatchContextRow,
  snapshot: readonly AgentStatusIpcPayload[],
  effort?: string | null
): RouteIdentity | null {
  const status = statusForDispatch(dispatch, snapshot)
  if (!status?.model || !status.agentType || !isTuiAgent(status.agentType)) {
    return null
  }
  return {
    agent: status.agentType,
    model: status.model,
    // The provider reports the model; effort is Orca's own launch parameter, so
    // it is read back from the worker record rather than invented here.
    reasoning: effort ?? null
  }
}

/** The effort the runtime actually launched with, from the worker record. */
export function readDispatchLaunchEffort(startOptions: string | undefined): string | null {
  try {
    const options = startOptions ? JSON.parse(startOptions) : null
    const effective = options?.launch?.effective
    return typeof effective?.effort === 'string' ? effective.effort : null
  } catch {
    return null
  }
}
