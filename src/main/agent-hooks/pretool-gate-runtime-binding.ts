import { launchTokenHash } from '../../shared/agent-hook-spool'
import { ControlPlaneStore } from '../runtime/orchestration/control-plane/control-plane-store'
import {
  evaluateCommittedPretoolPolicy,
  hasCommittedPretoolPolicy
} from '../runtime/orchestration/control-plane/pretool-policy-evaluation'
import { recordPretoolReceipt } from '../runtime/orchestration/control-plane/pretool-receipt'
import { readDispatchLaunchRoutes } from '../runtime/orchestration/control-plane/route-runtime-events'
import { resolveWorkerMutationVerdict } from '../runtime/orchestration/control-plane/worker-mutation-verdict'
import { readDispatchProviderSessionBinding } from '../runtime/orchestration/control-plane/provider-session-identity'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { canBlockBeforeMutation } from './pretool-blocking-capability'
import type { PretoolGateRequest, PretoolMutationVerdict } from './pretool-gate'

/** Correction — the production wiring between the hook gate and the lease state.
 *
 *  The gate is only a fence if something installs it. This is that something:
 *  the runtime owns the orchestration database, so it supplies the answer, and
 *  the hook adapter stays free of control-plane imports.
 *
 *  Nothing the request states about identity or location is believed. The pane
 *  key is what the hook transport authenticated; everything else — terminal,
 *  process incarnation, workspace — is looked up, and the launch token is
 *  checked against the hash the Dispatch was started with. In particular the
 *  request's `worktreeId` is NEVER used to decide anything: a shell outlives the
 *  environment it was launched with, so a stale or edited value could name a
 *  workspace nobody is fencing.
 *
 *  Supervision is the discriminator for how failure is treated. A pane that
 *  resolves to an active Dispatch is supervised work Orca is answerable for, and
 *  anything it cannot pin about that session is a denial. A pane with no
 *  Dispatch is an ordinary session and keeps working.
 */

const UNPLACEABLE_SUPERVISED =
  'This pane is running supervised work, but Orca cannot resolve the terminal and workspace it occupies, so it will not be allowed to mutate anything.'

const UNATTRIBUTABLE_SUPERVISED =
  'This pane is running supervised work, but the tool call cannot be attributed to the exact session that work was dispatched to.'

const CONTROL_PLANE_UNREACHABLE =
  'This pane is running supervised work and Orca could not complete the mutation check, so the mutation is refused rather than assumed safe.'

/** True when this pane is carrying work Orca dispatched. Looked up by pane
 *  alone, so it still answers when placement resolution has failed — which is
 *  exactly the case that must not be allowed to read as "unsupervised". */
function supervisedDispatchFor(runtime: OrcaRuntimeService, paneKey: string) {
  return runtime.getOrchestrationDb().getActiveDispatchForIdentity('', paneKey)
}

function providerSessionId(payload: Record<string, unknown>): string | null {
  const value = payload.session_id ?? payload.sessionId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createPretoolMutationResolver(
  runtime: OrcaRuntimeService
): (request: PretoolGateRequest) => PretoolMutationVerdict {
  return (request) => {
    if (!canBlockBeforeMutation(request.source)) {
      // Nothing returned here could stop the tool; saying "deny" would claim a
      // protection that does not exist. Admission refuses these routes instead.
      return { deny: false }
    }
    let dispatch
    try {
      dispatch = supervisedDispatchFor(runtime, request.paneKey)
    } catch {
      // Cannot even establish whether this is supervised work. That question is
      // the one that decides how leniently to fail, so failing it is not a pass.
      return { deny: true, reason: CONTROL_PLANE_UNREACHABLE }
    }
    let placement
    try {
      placement = runtime.resolveAttestedPanePlacement(request.paneKey)
    } catch {
      return { deny: true, reason: CONTROL_PLANE_UNREACHABLE }
    }
    // No request-worktree fallback anywhere: the workspace a mutation lands in
    // is the one the runtime placed this pane in, or the call is refused.
    if (!placement?.terminalHandle || !placement.worktreeId) {
      return dispatch ? { deny: true, reason: UNPLACEABLE_SUPERVISED } : { deny: false }
    }
    // A pane key is a location. The launch token proves this is the session Orca
    // started there, and the incarnation proves it is still the same process.
    // An active supervised Dispatch must have BOTH recorded and BOTH matching —
    // a missing one is an unproven session, not an exempt one.
    if (
      dispatch &&
      (!dispatch.launch_token_hash ||
        !request.launchToken ||
        launchTokenHash(request.launchToken) !== dispatch.launch_token_hash)
    ) {
      return { deny: true, reason: UNATTRIBUTABLE_SUPERVISED }
    }
    if (dispatch && (!placement.processIncarnation || !dispatch.process_incarnation)) {
      return { deny: true, reason: UNATTRIBUTABLE_SUPERVISED }
    }
    if (dispatch) {
      const binding = readDispatchProviderSessionBinding(runtime.getOrchestrationDb(), dispatch.id)
      if (
        !binding ||
        binding.processIncarnation !== placement.processIncarnation ||
        providerSessionId(request.payload) !== binding.id
      ) {
        return { deny: true, reason: UNATTRIBUTABLE_SUPERVISED }
      }
    }
    // Certification evidence is minted only on this synchronous provider hook
    // path. A worker-facing RPC cannot manufacture an ALLOW by choosing a
    // harmless payload: the payload below is the one the hook transport just
    // received before the provider executes the tool.
    if (
      dispatch &&
      hasCommittedPretoolPolicy({ db: runtime.getOrchestrationDb(), dispatchId: dispatch.id })
    ) {
      try {
        const observed = evaluateCommittedPretoolPolicy({
          db: runtime.getOrchestrationDb(),
          dispatchId: dispatch.id,
          payload: request.payload
        })
        const worker = runtime.getOrchestrationDb().getWorkerDispatch(dispatch.id)
        const outcome = new ControlPlaneStore(runtime.getOrchestrationDb()).getOutcomeByRun(
          dispatch.run_id
        )
        const launch = readDispatchLaunchRoutes(worker?.start_options)
        recordPretoolReceipt(runtime.getOrchestrationDb(), {
          binding: {
            dispatchId: dispatch.id,
            runId: dispatch.run_id,
            outcomeId: outcome?.outcome_id ?? null,
            taskId: dispatch.task_id,
            terminalHandle: dispatch.assignee_handle,
            paneKey: dispatch.assignee_pane_key,
            processIncarnation: dispatch.process_incarnation,
            requestedRoute: launch.requested,
            effectiveRoute: launch.effective,
            buildId: runtime.getBuildIdentity().id
          },
          claim: {
            decision: observed.decision,
            policyId: observed.policyId,
            policyVersion: observed.policyVersion,
            toolName: observed.toolName,
            reason: observed.reason
          },
          observedAt: new Date().toISOString()
        })
        if (observed.decision === 'block') {
          return canBlockBeforeMutation(request.source)
            ? {
                deny: true,
                reason: observed.reason ?? 'The committed PreTool policy blocked this tool.'
              }
            : { deny: false }
        }
      } catch {
        // A present policy that cannot be evaluated is a failed security
        // boundary, not an ALLOW. Only a genuinely absent policy skips this
        // repository-specific bridge.
        return { deny: true, reason: CONTROL_PLANE_UNREACHABLE }
      }
    }
    try {
      const verdict = resolveWorkerMutationVerdict({
        db: runtime.getOrchestrationDb(),
        session: {
          terminalHandle: placement.terminalHandle,
          paneKey: request.paneKey,
          processIncarnation: placement.processIncarnation,
          worktreeId: placement.worktreeId
        },
        nowMs: Date.now()
      })
      return verdict.decision === 'deny' ? { deny: true, reason: verdict.reason } : { deny: false }
    } catch {
      return { deny: true, reason: CONTROL_PLANE_UNREACHABLE }
    }
  }
}
