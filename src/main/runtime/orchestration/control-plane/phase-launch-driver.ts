import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../db'
import { WAKE_REASON_PAYLOAD_KEY } from './coordinator-wake-events'
import {
  PHASE_LAUNCH_MAX_ATTEMPTS,
  PhaseLaunchStore,
  type PhaseLaunchRow
} from './phase-launch-store'

/** B7 (correction 3) — the driver that actually starts a planned phase.
 *
 *  Creating the Task is deliberately NOT the end of the lifecycle: this is the
 *  step that turns a planned reviewer or correction phase into a running
 *  worker. It never launches anything itself — it calls the caller-supplied
 *  `PhaseWorkerStarter`, which is the existing `orchestration.workerStart`
 *  method, so there is no parallel launcher.
 *
 *  Lost-response contract: the driver hands worker-start a durable mutation
 *  request id derived from the phase id. If the response is lost, the retry
 *  re-presents the SAME id; worker-start's own receipt store either replays the
 *  accepted Dispatch or refuses the duplicate, so the driver reconciles the
 *  original Task/Dispatch and never creates a replacement. When it cannot
 *  reconcile within `PHASE_LAUNCH_MAX_ATTEMPTS` it fails closed and publishes a
 *  protected blocker rather than starting a second session.
 */

export type PhaseStartRequest = {
  runId: string
  taskId: string
  phaseId: string
  kind: 'review' | 'fix_first'
  /** The certified route the plan selected. Never chosen here. */
  route: { agent: string; model: string | null; reasoning: string | null }
  /** Set for a retained re-engagement; absent means a fresh independent session. */
  terminalHandle: string | null
  /** The worktree holding the reviewed commit; a fresh session lands there. */
  worktreeId: string | null
  boundSha: string
  /** Stable across retries so the existing worker-start receipt dedupes them. */
  mutationRequestId: string
  payloadHash: string
}

export type PhaseStartResult =
  | { kind: 'started'; dispatchId: string }
  /** The response was lost, or worker-start reported an unknown outcome. */
  | { kind: 'unknown'; reason: string }
  /** No certified route, or the role cannot be launched right now. */
  | { kind: 'blocked'; reason: string }
  /** worker-start created a Dispatch but its own flow failed. The Dispatch id
   *  is recorded so recovery can see it and no replacement is ever started. */
  | { kind: 'failed'; reason: string; dispatchId?: string }

export type PhaseWorkerStarter = {
  start(request: PhaseStartRequest): Promise<PhaseStartResult>
  /** Recovers the Dispatch a previous, possibly lost, start already accepted. */
  reconcile(request: PhaseStartRequest): Promise<{ dispatchId: string } | null>
}

export const PHASE_LAUNCH_CALLER_FINGERPRINT = 'orca:lifecycle-phase-driver'

export function phaseLaunchPayloadHash(row: PhaseLaunchRow): string {
  return createHash('sha256')
    .update(
      [
        row.phase_id,
        row.task_id,
        row.kind,
        row.agent ?? '',
        row.model ?? '',
        row.reasoning ?? '',
        row.terminal_handle ?? '',
        row.worktree_id ?? '',
        row.bound_sha
      ].join('|')
    )
    .digest('hex')
}

function toRequest(row: PhaseLaunchRow): PhaseStartRequest | null {
  if (!row.agent) {
    return null
  }
  return {
    runId: row.run_id,
    taskId: row.task_id,
    phaseId: row.phase_id,
    kind: row.kind,
    route: { agent: row.agent, model: row.model, reasoning: row.reasoning },
    terminalHandle: row.terminal_handle,
    worktreeId: row.worktree_id,
    boundSha: row.bound_sha,
    // Why the phase id: it is the idempotency key of the whole launch, so a
    // retried attempt presents the identical durable request.
    mutationRequestId: `phase_launch:${row.phase_id}`,
    payloadHash: phaseLaunchPayloadHash(row)
  }
}

export type PhaseLaunchReport = {
  phaseId: string
  taskId: string
  kind: PhaseLaunchRow['kind']
  state: PhaseLaunchRow['state']
  dispatchId: string | null
  reason?: string
}

export type PhaseLaunchDriveResult = {
  launched: PhaseLaunchReport[]
  blockerMessageIds: string[]
}

/** Drives every actionable phase launch for one Run. Safe to call repeatedly:
 *  a phase already `started`, `blocked` or `failed` is skipped, and a phase
 *  another driver is mid-start on cannot be claimed twice. */
export async function drivePhaseLaunches(args: {
  db: OrchestrationDb
  runId: string
  starter: PhaseWorkerStarter
  nowMs: number
  notify?: (handle: string, messageType: string) => void
}): Promise<PhaseLaunchDriveResult> {
  const store = new PhaseLaunchStore(args.db)
  const nowIso = new Date(args.nowMs).toISOString()
  const launched: PhaseLaunchReport[] = []
  const blockerMessageIds: string[] = []

  for (const pending of store.listActionable(args.runId)) {
    const request = toRequest(pending)
    if (!request && pending.dispatch_id) {
      // A row with no route but an existing Dispatch already launched: calling
      // that `blocked` would strand a live worker and report it as never started.
      store.markStarted(pending.phase_id, pending.dispatch_id, nowIso)
      launched.push(report(store, pending.phase_id))
      continue
    }
    if (!request) {
      store.markOutcome(
        pending.phase_id,
        'blocked',
        'No certified route was bound to this phase.',
        nowIso
      )
      // Why only on transition: a blocked phase is retried every tick until the
      // route is certified, and re-publishing would spam the wake set.
      if (pending.state !== 'blocked') {
        blockerMessageIds.push(publishLaunchBlocker(args, pending, 'no_certified_route'))
      }
      launched.push(report(store, pending.phase_id, 'No certified route was bound to this phase.'))
      continue
    }
    // Why reconcile first: a previous attempt may have succeeded with its
    // response lost, and re-launching would create a second session.
    const alreadyStarted =
      pending.state === 'start_unknown' ? await safeReconcile(args.starter, request) : null
    if (alreadyStarted) {
      store.markStarted(pending.phase_id, alreadyStarted.dispatchId, nowIso)
      launched.push(report(store, pending.phase_id))
      continue
    }
    if (!store.claimForStart(pending.phase_id, nowIso)) {
      continue
    }
    const claimed = store.get(pending.phase_id) as PhaseLaunchRow
    const result = await runStart(args.starter, request)
    if (result.kind === 'started') {
      store.markStarted(pending.phase_id, result.dispatchId, nowIso)
      launched.push(report(store, pending.phase_id))
      continue
    }
    if (result.kind === 'blocked') {
      store.markOutcome(pending.phase_id, 'blocked', result.reason, nowIso)
      if (pending.state !== 'blocked') {
        blockerMessageIds.push(
          publishLaunchBlocker(args, claimed, 'no_certified_route', result.reason)
        )
      }
      launched.push(report(store, pending.phase_id, result.reason))
      continue
    }
    const exhausted = claimed.attempts >= PHASE_LAUNCH_MAX_ATTEMPTS
    if (result.kind === 'unknown' && !exhausted) {
      store.markOutcome(pending.phase_id, 'start_unknown', result.reason, nowIso)
      launched.push(report(store, pending.phase_id, result.reason))
      continue
    }
    // Fail closed: never substitute a fresh session for one that may exist.
    if (result.kind === 'failed' && result.dispatchId) {
      store.recordFailedDispatch(pending.phase_id, result.dispatchId, nowIso)
    }
    store.markOutcome(pending.phase_id, 'failed', result.reason, nowIso)
    blockerMessageIds.push(
      publishLaunchBlocker(args, claimed, 'phase_launch_failed', result.reason)
    )
    launched.push(report(store, pending.phase_id, result.reason))
  }
  return { launched, blockerMessageIds }
}

async function runStart(
  starter: PhaseWorkerStarter,
  request: PhaseStartRequest
): Promise<PhaseStartResult> {
  try {
    return await starter.start(request)
  } catch (error) {
    // Why `unknown` and not `failed`: a thrown start may still have created the
    // Dispatch, so the next pass must reconcile before deciding anything.
    return { kind: 'unknown', reason: String(error) }
  }
}

async function safeReconcile(
  starter: PhaseWorkerStarter,
  request: PhaseStartRequest
): Promise<{ dispatchId: string } | null> {
  try {
    return await starter.reconcile(request)
  } catch {
    return null
  }
}

function report(store: PhaseLaunchStore, phaseId: string, reason?: string): PhaseLaunchReport {
  const row = store.get(phaseId) as PhaseLaunchRow
  return {
    phaseId,
    taskId: row.task_id,
    kind: row.kind,
    state: row.state,
    dispatchId: row.dispatch_id,
    ...(reason ? { reason } : {})
  }
}

function publishLaunchBlocker(
  args: { db: OrchestrationDb; runId: string; notify?: (handle: string, type: string) => void },
  row: PhaseLaunchRow,
  code: string,
  reason?: string
): string {
  const message = args.db.insertMessage({
    runId: args.runId,
    from: 'orca:runtime-lifecycle',
    to: `run:${args.runId}`,
    subject: `Protected blocker: ${code}`,
    body:
      reason ??
      `The ${row.kind} phase for task ${row.task_id} could not be started on a certified route.`,
    type: 'escalation',
    priority: 'urgent',
    payload: JSON.stringify({
      [WAKE_REASON_PAYLOAD_KEY]: 'escalation',
      protectedBlocker: true,
      code,
      phaseId: row.phase_id,
      taskId: row.task_id,
      kind: row.kind
    })
  })
  args.notify?.(`run:${args.runId}`, 'escalation')
  return message.id
}
