import type { OrchestrationDb } from '../db'
import type { DispatchContextRow } from '../types'
import type { CompletionClaim } from './completion-receipt'
import { WAKE_REASON_PAYLOAD_KEY } from './coordinator-wake-events'
import type { OutcomePhaseRow, OutcomePolicyStore } from './outcome-policy'
import { PhaseLaunchStore } from './phase-launch-store'
import type { ReviewerAdvancePlan } from './reviewer-advance'

/** B7 (correction 2) — turning a plan into real Tasks, phases and wakes.
 *  Split from the decision logic so each half stays readable. */
export function executePlan(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  taskId: string
  outcomeId: string
  policyStore: OutcomePolicyStore
  plan: ReviewerAdvancePlan
  phase: OutcomePhaseRow | undefined
  claim: CompletionClaim
  notify?: (handle: string, messageType: string) => void
}): { phase: OutcomePhaseRow | null; wakeMessageId: string | null } {
  const { db, dispatch, plan } = args
  const runId = dispatch.run_id
  const address = `run:${runId}`

  if (plan.kind === 'blocked') {
    // Why the dedupe: a replayed completion re-runs the advance, and without
    // this the coordinator is woken a second time for the SAME stall. Phases
    // are already replay-safe through their unique index; the blocker branch
    // needs the same guarantee, keyed on (dispatch, code).
    const existing = findProtectedBlocker(db, runId, dispatch.id, plan.code)
    if (existing) {
      return { phase: null, wakeMessageId: existing }
    }
    const message = db.insertMessage({
      runId,
      from: 'orca:runtime-lifecycle',
      to: address,
      subject: `Protected blocker: ${plan.code}`,
      body: plan.reason,
      type: 'escalation',
      priority: 'urgent',
      payload: JSON.stringify({
        [WAKE_REASON_PAYLOAD_KEY]: 'escalation',
        protectedBlocker: true,
        code: plan.code,
        dispatchId: dispatch.id,
        taskId: args.taskId
      })
    })
    args.notify?.(address, 'escalation')
    return { phase: null, wakeMessageId: message.id }
  }

  if (plan.kind === 'review') {
    const task = db.createTask({
      runId,
      spec: buildReviewSpec(plan.boundSha, args.taskId),
      taskTitle: `Review ${plan.boundSha.slice(0, 12)}`,
      parentId: args.taskId
    })
    const phase = args.policyStore.insertPhase({
      phase_id: `phase_${task.id}`,
      outcome_id: args.outcomeId,
      run_id: runId,
      kind: 'review',
      task_id: task.id,
      source_task_id: args.taskId,
      source_dispatch_id: dispatch.id,
      bound_sha: plan.boundSha
    })
    // Why here: the route was already selected from the certified registry, so
    // the launch record binds it durably. The driver starts it; it never picks.
    new PhaseLaunchStore(db).recordPlanned({
      phaseId: phase.phase_id,
      runId,
      outcomeId: args.outcomeId,
      taskId: phase.task_id,
      kind: 'review',
      route: plan.route.identity,
      // A reviewer is always an independent FRESH session.
      terminalHandle: null,
      worktreeId: db.getWorkerTerminalResourceByOwner(dispatch.id)?.worktree_id ?? null,
      boundSha: plan.boundSha
    })
    return { phase, wakeMessageId: announcePhase(db, runId, phase, args.notify) }
  }

  const task = db.createTask({
    runId,
    spec: buildFixFirstSpec(plan.boundSha, plan.corrections),
    taskTitle: `Corrections for ${plan.boundSha.slice(0, 12)}`,
    parentId: args.taskId
  })
  const phase = args.policyStore.insertPhase({
    phase_id: `phase_${task.id}`,
    outcome_id: args.outcomeId,
    run_id: runId,
    kind: 'fix_first',
    task_id: task.id,
    source_task_id: args.taskId,
    source_dispatch_id: dispatch.id,
    bound_sha: plan.boundSha
  })
  new PhaseLaunchStore(db).recordPlanned({
    phaseId: phase.phase_id,
    runId,
    outcomeId: args.outcomeId,
    taskId: phase.task_id,
    kind: 'fix_first',
    route: plan.route.identity,
    // Why the terminal: FIX_FIRST re-engages the SAME retained builder session,
    // so the launch reuses its terminal instead of creating a new one.
    terminalHandle: plan.terminalHandle,
    worktreeId: db.getWorkerTerminalResourceByOwner(plan.builderDispatchId)?.worktree_id ?? null,
    boundSha: plan.boundSha
  })
  return { phase, wakeMessageId: announcePhase(db, runId, phase, args.notify) }
}

/** The created phase is announced as a non-waking `dispatch` row: it belongs in
 *  the Run history, but planning the next phase is not itself something the
 *  coordinator must be woken for. */
export function announcePhase(
  db: OrchestrationDb,
  runId: string,
  phase: OutcomePhaseRow,
  notify?: (handle: string, messageType: string) => void
): string {
  const message = db.insertMessage({
    runId,
    from: 'orca:runtime-lifecycle',
    to: `run:${runId}`,
    subject: `Planned ${phase.kind} phase task ${phase.task_id}`,
    body: `Bound to SHA ${phase.bound_sha}.`,
    type: 'dispatch',
    payload: JSON.stringify({
      phaseId: phase.phase_id,
      kind: phase.kind,
      taskId: phase.task_id,
      boundSha: phase.bound_sha
    })
  })
  notify?.(`run:${runId}`, 'dispatch')
  return message.id
}

export function buildReviewSpec(boundSha: string, sourceTaskId: string): string {
  return [
    `Independently review the delivered work of task ${sourceTaskId}.`,
    `Review exactly commit ${boundSha}; do not review the branch tip.`,
    'Report with `orchestration report`. Pass --corrections "<a>,<b>" for every required change;',
    'omit --corrections only when the commit is acceptable as delivered.'
  ].join('\n')
}

export function buildFixFirstSpec(boundSha: string, corrections: readonly string[]): string {
  return [
    `Apply ONE consolidated correction round on top of ${boundSha}.`,
    'Required changes:',
    ...corrections.map((correction, index) => `  ${index + 1}. ${correction}`),
    '',
    'Rerun every gate the new commit invalidates, then report with the receipt bound to the new HEAD.'
  ].join('\n')
}

/** REVIEW_COMPLETE: a typed escalation, so it lands in the canonical wake set
 *  and reaches a coordinator sitting in `orchestration.await`. */
export function publishReviewComplete(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  taskId: string
  boundSha: string
  notify?: (handle: string, messageType: string) => void
}): string {
  const message = args.db.insertMessage({
    runId: args.runId,
    from: 'orca:runtime-lifecycle',
    to: `run:${args.runId}`,
    subject: `Review complete for ${args.boundSha.slice(0, 12)}`,
    body: 'The independent reviewer accepted the delivered commit with no corrections.',
    type: 'escalation',
    priority: 'high',
    payload: JSON.stringify({
      [WAKE_REASON_PAYLOAD_KEY]: 'review_complete',
      dispatchId: args.dispatchId,
      taskId: args.taskId,
      boundSha: args.boundSha
    })
  })
  args.notify?.(`run:${args.runId}`, 'escalation')
  return message.id
}

/** Tells the coordinator that a settled completion did NOT earn a next phase,
 *  and why. Deduped on (dispatch, code) the same way a protected blocker is, so
 *  a replayed completion never wakes a parked coordinator twice. */
export function publishAdvanceBlocked(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  taskId: string
  code: string
  reason: string
  notify?: (handle: string, messageType: string) => void
}): string {
  const existing = findProtectedBlocker(args.db, args.runId, args.dispatchId, args.code)
  if (existing) {
    return existing
  }
  const message = args.db.insertMessage({
    runId: args.runId,
    from: 'orca:runtime-lifecycle',
    to: `run:${args.runId}`,
    subject: `Protected blocker: ${args.code}`,
    body: args.reason,
    type: 'escalation',
    priority: 'urgent',
    payload: JSON.stringify({
      [WAKE_REASON_PAYLOAD_KEY]: 'escalation',
      protectedBlocker: true,
      code: args.code,
      dispatchId: args.dispatchId,
      taskId: args.taskId
    })
  })
  args.notify?.(`run:${args.runId}`, 'escalation')
  return message.id
}

/** The id of an already-published protected blocker for this exact Dispatch and
 *  code, or null. Scanning the Run's own escalation history keeps the guard
 *  additive: no new table, and it survives a restart because the mailbox does. */
function findProtectedBlocker(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string,
  code: string
): string | null {
  for (const message of db.getRunMailboxHistory(runId, 100, ['escalation'])) {
    if (!message.payload) {
      continue
    }
    try {
      const payload = JSON.parse(message.payload) as {
        protectedBlocker?: boolean
        code?: string
        dispatchId?: string
      }
      if (payload.protectedBlocker && payload.code === code && payload.dispatchId === dispatchId) {
        return message.id
      }
    } catch {
      // A malformed payload is not a match.
    }
  }
  return null
}
