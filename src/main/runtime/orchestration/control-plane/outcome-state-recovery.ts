import type { DispatchContextRow, MessageRow, TaskRow } from '../types'
import type { ControlPlaneStore, OutcomeRow } from './control-plane-store'
import { classifyWakeReason, type CoordinatorWakeReason } from './coordinator-wake-events'
import {
  readLivenessMarker,
  type LivenessActivity,
  type LivenessVerdict
} from './dispatch-liveness'
import {
  resolveRouteCertification,
  type CertificationState,
  type RouteEvidence
} from './route-certification-evidence'
import { routeKey, type RouteIdentity, type RouteRole } from './route-registry-types'

/** B10 — one bounded structured answer for "what is the exact state of this
 *  outcome / Run / Task / Dispatch, and what may I legally do next?".
 *
 *  Recovery must never need a full worker-list dump, transcript archaeology, a
 *  chain of status/list/show calls, or shell-syntax discovery. Everything below
 *  is a fixed-size record; `lastMeaningfulEvent` is at most one message.
 */

export type OutcomeStateSelector = {
  outcomeId?: string
  runId?: string
  taskId?: string
  dispatchId?: string
}

export type NextLegalAction =
  | 'admit_outcome'
  | 'create_task'
  | 'start_worker'
  | 'wait_for_wake'
  | 'answer_question'
  | 'resolve_escalation'
  | 'validate_completion'
  | 'advance_to_review'
  | 'fix_first'
  | 'recertify_route'
  | 'escalate_protected_blocker'

export type OutcomeStateReport = {
  identity: {
    outcomeId: string | null
    runId: string | null
    taskId: string | null
    dispatchId: string | null
    /** True when the Run predates outcome admission and can only be read. */
    legacyUnbound: boolean
  }
  lifecycle: {
    outcomeStatus: OutcomeRow['status'] | null
    taskStatus: TaskRow['status'] | null
    dispatchStatus: DispatchContextRow['status'] | null
  }
  lastMeaningfulEvent: {
    messageId: string
    type: MessageRow['type']
    wakeReason: CoordinatorWakeReason | null
    subject: string
    createdAt: string
  } | null
  liveness: {
    verdict: LivenessVerdict
    activity: LivenessActivity
    reason: string
    expired: boolean
  }
  route: {
    identity: RouteIdentity | null
    routeKey: string | null
    certification: CertificationState
    failureReason: string | null
  }
  completionGate: {
    required: boolean
    satisfied: boolean
    /** The gate that is currently blocking, when one is. */
    blockingGate: string | null
  }
  nextLegalActions: NextLegalAction[]
}

export type OutcomeStateSources = {
  store: ControlPlaneStore
  outcome?: OutcomeRow
  task?: TaskRow
  dispatch?: DispatchContextRow
  /** At most the newest wake-worthy message for this Run; not the whole inbox. */
  recentMessages?: readonly MessageRow[]
  routeEvidence?: readonly RouteEvidence[]
  routeIdentity?: RouteIdentity | null
  routeRole?: RouteRole
  completionGate?: { required: boolean; satisfied: boolean; blockingGate: string | null }
  nowMs: number
}

function pickLastMeaningfulEvent(
  messages: readonly MessageRow[]
): OutcomeStateReport['lastMeaningfulEvent'] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const wakeReason = classifyWakeReason(message)
    if (wakeReason) {
      return {
        messageId: message.id,
        type: message.type,
        wakeReason,
        subject: message.subject,
        createdAt: message.created_at
      }
    }
  }
  return null
}

function resolveNextLegalActions(
  report: Omit<OutcomeStateReport, 'nextLegalActions'>
): NextLegalAction[] {
  const actions: NextLegalAction[] = []
  if (!report.identity.outcomeId) {
    actions.push('admit_outcome')
    return actions
  }
  if (report.route.certification !== 'PASS' && report.route.identity) {
    actions.push('recertify_route', 'escalate_protected_blocker')
  }
  if (!report.identity.taskId) {
    actions.push('create_task')
    return actions
  }
  if (!report.identity.dispatchId || report.lifecycle.dispatchStatus === 'failed') {
    actions.push('start_worker')
    return actions
  }
  const wake = report.lastMeaningfulEvent?.wakeReason
  if (wake === 'question') {
    actions.push('answer_question')
  }
  if (wake === 'escalation' || wake === 'stalled' || wake === 'crashed' || wake === 'ci_blocker') {
    actions.push('resolve_escalation')
  }
  if (wake === 'worker_done') {
    actions.push(report.completionGate.satisfied ? 'advance_to_review' : 'validate_completion')
  }
  if (wake === 'review_complete') {
    actions.push('fix_first', 'advance_to_review')
  }
  if (actions.length === 0) {
    actions.push('wait_for_wake')
  }
  return actions
}

/** Anything that is not still awaiting or running work is settled. */
function isSettledDispatchStatus(status: DispatchContextRow['status'] | undefined): boolean {
  return status !== undefined && status !== 'pending' && status !== 'dispatched'
}

export function describeOutcomeState(
  selector: OutcomeStateSelector,
  sources: OutcomeStateSources
): OutcomeStateReport {
  const outcome =
    sources.outcome ??
    (selector.outcomeId
      ? sources.store.getOutcomeById(selector.outcomeId)
      : selector.runId
        ? sources.store.getOutcomeByRun(selector.runId)
        : undefined)
  const runId = outcome?.run_id ?? selector.runId ?? sources.task?.run_id ?? null
  const dispatchId = sources.dispatch?.id ?? selector.dispatchId ?? null
  const certification = sources.routeIdentity
    ? resolveRouteCertification(sources.routeEvidence ?? [], {
        identity: sources.routeIdentity,
        role: sources.routeRole ?? 'builder',
        sessionMode: 'fresh',
        nowMs: sources.nowMs
      })
    : undefined

  const base: Omit<OutcomeStateReport, 'nextLegalActions'> = {
    identity: {
      outcomeId: outcome?.outcome_id ?? null,
      runId,
      taskId: sources.task?.id ?? selector.taskId ?? null,
      dispatchId,
      legacyUnbound: Boolean(runId) && !outcome
    },
    lifecycle: {
      outcomeStatus: outcome?.status ?? null,
      taskStatus: sources.task?.status ?? null,
      dispatchStatus: sources.dispatch?.status ?? null
    },
    lastMeaningfulEvent: pickLastMeaningfulEvent(sources.recentMessages ?? []),
    liveness: dispatchId
      ? readLivenessMarker(
          sources.store,
          dispatchId,
          sources.nowMs,
          isSettledDispatchStatus(sources.dispatch?.status)
        )
      : {
          verdict: 'unverifiable',
          activity: 'working',
          reason: 'No Dispatch selected.',
          expired: false
        },
    route: {
      identity: sources.routeIdentity ?? null,
      routeKey: sources.routeIdentity ? routeKey(sources.routeIdentity) : null,
      certification: certification?.state ?? 'UNTESTED',
      failureReason: certification && certification.state !== 'PASS' ? certification.reason : null
    },
    completionGate: sources.completionGate ?? {
      required: Boolean(outcome),
      satisfied: false,
      blockingGate: null
    }
  }
  return { ...base, nextLegalActions: resolveNextLegalActions(base) }
}
