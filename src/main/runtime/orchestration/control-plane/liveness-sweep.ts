import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { OrchestrationDb } from '../db'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import { readObservedLaunchIdentity } from './certification-event-source'
import {
  observeProviderSessionIdentity,
  persistObservedLaunchReceipt
} from './provider-session-identity'
import { readDispatchLaunchEffort } from './route-runtime-events'
import type { DispatchContextRow } from '../types'
import { COORDINATOR_WAKE_REASONS, WAKE_REASON_PAYLOAD_KEY } from './coordinator-wake-events'
import { ControlPlaneStore } from './control-plane-store'
import {
  DEFAULT_LIVENESS_POLICY,
  sweepDispatchLiveness,
  type LivenessPolicy,
  type LivenessWake
} from './dispatch-liveness'
import {
  selectDispatchAgentStatus,
  toLivenessEvidence,
  type DispatchLivenessSignals
} from './dispatch-liveness-evidence'

/** B4 (correction 2) — the production owner of runtime liveness.
 *
 *  Trigger: `runLivenessSweep` is called by the durable `orchestration.await`
 *  wait on its own runtime interval. The `orchestration.state` recovery query
 *  does NOT sweep — it is read-only, and a sweep publishes wakes — so it reads
 *  the Dispatch's own settled status alongside the marker instead.
 *  There is no unconditional background timer: a Run with no waiter and no
 *  recovery query has nothing to wake, and its marker correctly ages out to
 *  `unverifiable` instead of asserting health.
 *
 *  Clock: `nowMs` is supplied by the runtime caller (`Date.now()`), never by a
 *  model-authored timestamp.
 *
 *  Persistence: `control_plane_dispatch_liveness`, one row per Dispatch,
 *  written only here.
 *
 *  Idempotent transition: `sweepDispatchLiveness` emits a wake only on the
 *  transition INTO stalled/crashed and records it in `woke_for`, so repeated
 *  sweeps in the same state publish nothing.
 *
 *  Re-arm: every sweep rewrites `expires_at = observed_at + markerTtlMs`.
 *
 *  Shutdown: the sweep owns no timer of its own; `LivenessSweepScheduler` does,
 *  and its `stop()` is called from the wait's `finally`, so a closed RPC socket
 *  or a runtime shutdown ends it deterministically.
 *
 *  Terminal resolver: `crashed` and `settled` mark the marker terminal, and the
 *  store's upsert refuses to overwrite a terminal row.
 */

export type LivenessSignalSource = {
  /** Newest agent-hook rows the runtime holds. */
  agentStatusSnapshot(): readonly AgentStatusIpcPayload[]
  /** Execution-host process-table verdict for one worker incarnation. */
  inspectProcessLiveness(
    processIncarnation: string,
    hostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'>
  /** ISO deadline of an Orca-approved blocking wait the runtime owns, if any. */
  approvedWaitUntil(dispatchId: string): string | null
  /** Epoch ms of the last output the runtime observed on a worker's terminal,
   *  or null when the execution host cannot report one.
   *
   *  Why the incarnation: a terminal handle outlives the process bound to it, so
   *  reading the handle alone reported output from whatever occupies that pane
   *  now — a user typing in a reused pane read as a hung agent still working. */
  lastTerminalOutputAtMs?(
    terminalHandle: string | null,
    processIncarnation: string | null
  ): number | null
}

export type WakePublisher = {
  notifyMessageArrived(handle: string, messageType?: string): void
}

export function listActiveDispatchesForRun(
  db: OrchestrationDb,
  runId: string
): DispatchContextRow[] {
  return db.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE run_id = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid ASC`
    )
    .all(runId) as DispatchContextRow[]
}

function isDispatchSettled(dispatch: DispatchContextRow): boolean {
  return dispatch.status !== 'pending' && dispatch.status !== 'dispatched'
}

/** Settled Dispatches whose marker never got a terminal verdict.
 *
 *  Why this exists: a Dispatch that dies between two sweeps leaves the sweep's
 *  active set before anything can finalize its marker, so the last thing
 *  written stays `live` until the TTL — the exact false `live` the marker
 *  contract forbids. One more sweep closes it out.
 */
function listDispatchesNeedingLivenessFinalization(
  db: OrchestrationDb,
  runId: string
): DispatchContextRow[] {
  const settled = db.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE run_id = ? AND status NOT IN ('pending', 'dispatched')
       ORDER BY rowid ASC`
    )
    .all(runId) as DispatchContextRow[]
  const store = new ControlPlaneStore(db)
  return settled.filter((dispatch) => {
    const marker = store.getLivenessMarker(dispatch.id)
    return marker !== undefined && marker.terminal === 0
  })
}

/** Output the runtime saw BEFORE this Dispatch began proves nothing about it,
 *  so a timestamp under its start floor reads as no observed activity. */
function clampToDispatchStart(
  dispatch: DispatchContextRow,
  lastOutputAtMs: number | null
): number | null {
  if (lastOutputAtMs === null) {
    return null
  }
  // exposeUtcTimestamp: dispatch rows keep SQLite's timezone-less UTC space
  // format, which Date.parse reads as LOCAL time and shifts the floor by the
  // host's offset — enough to discard every real observation west of UTC.
  const startedAtMs = Date.parse(exposeUtcTimestamp(dispatch.created_at) ?? '')
  return Number.isFinite(startedAtMs) && lastOutputAtMs < startedAtMs ? null : lastOutputAtMs
}

/** Persists the provider's own effective identity once, the first time it can be
 *  observed. Silent and best effort: liveness must not fail because a provider
 *  has not yet said what it is. */
function recordObservedProviderIdentity(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  snapshot: readonly AgentStatusIpcPayload[]
): void {
  try {
    if (readObservedLaunchIdentity(db, dispatch.id)) {
      return
    }
    const worker = db.getWorkerDispatch(dispatch.id)
    const verdict = observeProviderSessionIdentity({
      dispatch,
      snapshot,
      reasoning: readDispatchLaunchEffort(worker?.start_options)
    })
    if (!verdict.ok) {
      return
    }
    persistObservedLaunchReceipt(db, {
      dispatchId: dispatch.id,
      identity: verdict.observation.identity,
      sessionId: verdict.observation.sessionId,
      observedAtIso: new Date(verdict.observation.observedAtMs || Date.now()).toISOString()
    })
  } catch {
    // An unobservable identity is simply not yet observed.
  }
}

async function collectSignals(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  source: LivenessSignalSource
): Promise<DispatchLivenessSignals> {
  const resource = db.getWorkerTerminalResourceByOwner(dispatch.id)
  // Why here: the sweep already holds this Dispatch and the runtime's own status
  // snapshot, which is exactly what is needed to notice that the provider has
  // stated which model it is running. Recording it here means the observation is
  // persisted while the session is alive, rather than being asked for later when
  // the transcript may be gone.
  recordObservedProviderIdentity(db, dispatch, source.agentStatusSnapshot())
  const processLiveness = dispatch.process_incarnation
    ? await source
        .inspectProcessLiveness(dispatch.process_incarnation, resource?.host_scope ?? null)
        // Why swallow: an unreachable host is `unverifiable`, never a crash.
        .catch(() => 'unverifiable' as const)
    : 'unverifiable'
  return {
    dispatch,
    agentStatus: selectDispatchAgentStatus(dispatch, source.agentStatusSnapshot()),
    processLiveness,
    approvedWaitUntilIso: source.approvedWaitUntil(dispatch.id),
    terminalOwnership: resource?.ownership_state ?? null,
    lastTerminalOutputAtMs: clampToDispatchStart(
      dispatch,
      source.lastTerminalOutputAtMs?.(dispatch.assignee_handle, dispatch.process_incarnation) ??
        null
    ),
    settled: isDispatchSettled(dispatch)
  }
}

export type LivenessSweepResult = {
  swept: number
  wakes: LivenessWake[]
  publishedMessageIds: string[]
}

/** Sweeps every active Dispatch of one Run and publishes the resulting wakes
 *  into that Run's mailbox as typed escalations. */
export async function runLivenessSweep(args: {
  db: OrchestrationDb
  runId: string
  source: LivenessSignalSource
  publisher?: WakePublisher
  nowMs: number
  policy?: LivenessPolicy
  /** Restrict the sweep to one Dispatch (the recovery-query path). */
  dispatchId?: string
}): Promise<LivenessSweepResult> {
  const { db, runId, source, nowMs } = args
  const all = [
    ...listActiveDispatchesForRun(db, runId),
    ...listDispatchesNeedingLivenessFinalization(db, runId)
  ]
  const dispatches = args.dispatchId ? all.filter((row) => row.id === args.dispatchId) : all
  if (dispatches.length === 0) {
    return { swept: 0, wakes: [], publishedMessageIds: [] }
  }
  const inputs = await Promise.all(
    dispatches.map(async (dispatch) => ({
      dispatchId: dispatch.id,
      evidence: toLivenessEvidence(await collectSignals(db, dispatch, source)),
      epoch: dispatch.process_incarnation
    }))
  )
  const { wakes } = sweepDispatchLiveness(
    new ControlPlaneStore(db),
    inputs,
    nowMs,
    args.policy ?? DEFAULT_LIVENESS_POLICY
  )
  const publishedMessageIds = publishLivenessWakes({
    db,
    runId,
    wakes,
    dispatches,
    publisher: args.publisher
  })
  return { swept: dispatches.length, wakes, publishedMessageIds }
}

/** Publishes one typed escalation per wake. The row is an ordinary escalation
 *  so an older reader still understands it; the typed reason rides in the
 *  payload, which is where `classifyWakeReason` reads it. */
export function publishLivenessWakes(args: {
  db: OrchestrationDb
  runId: string
  wakes: readonly LivenessWake[]
  dispatches: readonly DispatchContextRow[]
  publisher?: WakePublisher
}): string[] {
  const byId = new Map(args.dispatches.map((row) => [row.id, row]))
  const ids: string[] = []
  for (const wake of args.wakes) {
    const dispatch = byId.get(wake.dispatchId)
    const message = args.db.insertMessage({
      runId: args.runId,
      from: 'orca:runtime-liveness',
      to: `run:${args.runId}`,
      subject: `Worker ${wake.reason}: dispatch ${wake.dispatchId}`,
      body: wake.detail,
      type: 'escalation',
      priority: wake.reason === 'crashed' ? 'urgent' : 'high',
      payload: JSON.stringify({
        [WAKE_REASON_PAYLOAD_KEY]: wake.reason,
        dispatchId: wake.dispatchId,
        taskId: dispatch?.task_id ?? null,
        source: 'runtime_liveness_sweep'
      })
    })
    ids.push(message.id)
    args.publisher?.notifyMessageArrived(`run:${args.runId}`, 'escalation')
  }
  return ids
}

/** Owns the interval that drives the sweep while a coordinator is subscribed.
 *  Start/stop are explicit so the caller's `finally` is the shutdown path. */
export class LivenessSweepScheduler {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => void
  ) {}

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(this.tick, this.intervalMs)
    // Why unref: the sweep must never hold the process open at shutdown.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  get running(): boolean {
    return this.timer !== null
  }
}

/** Guard: every wake this module can publish must be in the canonical set. */
export function assertPublishableWakeReason(reason: string): void {
  if (!(COORDINATOR_WAKE_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`Unknown coordinator wake reason ${reason}`)
  }
}
