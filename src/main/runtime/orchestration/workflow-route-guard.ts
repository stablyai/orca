import { OrchestrationError } from './orchestration-error'
import type { MessageType } from './types'

export const WORKFLOW_ROUTE_REFUSED_CODE = 'workflow_route_refused'

export type WorkflowRouteGuardInput = {
  orcaRunId: string
  /** The sender's active Dispatch, when the sender is a worker. */
  senderDispatchId: string | undefined
  senderHandle: string
  /** The resolved recipient address (dispatch:<id>, run:<id>, a handle, or a group). */
  to: string
  type: MessageType
  subject: string
  body: string
  payload: string | undefined
}

export type WorkflowRouteGuardVerdict =
  | { action: 'allow' }
  | { action: 'refuse'; code: string; message: string }

export type WorkflowRouteGuard = (input: WorkflowRouteGuardInput) => WorkflowRouteGuardVerdict

// Keyed by Orca Run id: only Runs a workflow controller owns are policed.
const guards = new Map<string, WorkflowRouteGuard>()

export function registerWorkflowRouteGuard(
  orcaRunId: string,
  guard: WorkflowRouteGuard
): () => void {
  guards.set(orcaRunId, guard)
  return () => {
    if (guards.get(orcaRunId) === guard) {
      guards.delete(orcaRunId)
    }
  }
}

/** Refuse before any message row is written, so a refused send has no effects. */
export function assertWorkflowRoutePermitted(input: WorkflowRouteGuardInput | null): void {
  if (!input) {
    return
  }
  const guard = guards.get(input.orcaRunId)
  if (!guard) {
    return
  }
  const verdict = guard(input)
  if (verdict.action === 'refuse') {
    // One client-visible code; the specific policy rule rides in data.
    throw new OrchestrationError(WORKFLOW_ROUTE_REFUSED_CODE, verdict.message, {
      effectsApplied: false,
      policyCode: verdict.code
    })
  }
}

/** The `orchestration.send` entry: both point-to-point and group mail pass through here. */
export function assertWorkflowSendPermitted(
  orcaRunId: string | undefined,
  senderDispatchId: string | undefined,
  senderHandle: string,
  to: string,
  params: { type?: MessageType; subject: string; body?: string; payload?: string; run?: string }
): void {
  // A group send names its Run explicitly when the sender has no bound one.
  const runId = orcaRunId ?? params.run
  assertWorkflowRoutePermitted(
    runId
      ? {
          orcaRunId: runId,
          senderDispatchId,
          senderHandle,
          to,
          type: params.type ?? 'status',
          subject: params.subject,
          body: params.body ?? '',
          payload: params.payload
        }
      : null
  )
}
