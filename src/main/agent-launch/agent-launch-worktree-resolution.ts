// Two-stage host resolution for a worktree-creation `agentLaunch` request (U4).
// Stage 1 (pre-git) pins the concrete requested identity + config-only digest and
// takes one of the 256 admission reservations BEFORE any git side effect, so a
// launch_capacity_exceeded (or a deterministic identity/enabled/template failure)
// aborts creation without leaving an orphan worktree. Stage 2 (post-git) re-reads
// one atomic settings/catalog view for BOTH the digest recheck and final
// resolution against the authoritative worktree path, converting the held
// reservation into an admitted token/snapshot/plan or releasing it. The client's
// command/env/launchConfig/launchAgent are IGNORED — only the host-resolved plan
// spawns. Electron-free and injection-based so it is unit-testable.

import type { GlobalSettings } from '../../shared/types'
import type { AgentLaunchSpawnRequest } from '../../shared/agent-launch-spawn-request'
import type { LaunchIntent, ResolvedAgentLaunch } from '../../shared/agent-launch-host-contract'
import {
  detectionBaseAgentsForLaunch,
  deriveAgentLaunchHostState,
  type AgentLaunchHostDescriptor,
  type AgentLaunchHostStateDeps
} from './agent-launch-host-state'
import { buildHostStateResolve } from './agent-launch-spawn'
import { STARTUP_COMMAND_TEXT_MAX_CHARS } from '../providers/windows-shell-args'
import type { resolveAgentLaunch } from './resolve-agent-launch'
import type {
  AgentLaunchBoundary,
  ExecuteAgentLaunchResult,
  PrepareReservedAgentLaunchResult
} from './agent-launch-boundary'
import type { AdmissionPrincipal } from './agent-launch-admission-store'
import type {
  AgentLaunchFailure,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'

/** A pre-create (stage 1) launch rejection. Thrown so the worktree-create RPC
 *  aborts BEFORE any git mutation — capacity and deterministic identity/enabled/
 *  template failures create no worktree. The structured failure/requestError is
 *  carried for the caller surface to render; it is never a created-worktree
 *  result. */
export class WorktreeAgentLaunchPreCreateError extends Error {
  readonly failure?: AgentLaunchFailure
  readonly requestError?: AgentLaunchRequestError
  constructor(rejection: { failure?: AgentLaunchFailure; requestError?: AgentLaunchRequestError }) {
    super(
      rejection.failure
        ? `agent_launch_precreate_failed:${rejection.failure.code}`
        : `agent_launch_precreate_rejected:${rejection.requestError?.code ?? 'unknown'}`
    )
    this.name = 'WorktreeAgentLaunchPreCreateError'
    if (rejection.failure) {
      this.failure = rejection.failure
    }
    if (rejection.requestError) {
      this.requestError = rejection.requestError
    }
  }
}

export type WorktreeAgentLaunchDeps = {
  boundary: AgentLaunchBoundary
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  detectStockBaseAgents: AgentLaunchHostStateDeps['detectStockBaseAgents']
  resolveTargetHomePath: AgentLaunchHostStateDeps['resolveTargetHomePath']
  resolveStartupShell?: AgentLaunchHostStateDeps['resolveStartupShell']
  resolveTransportConfidentiality?: AgentLaunchHostStateDeps['resolveTransportConfidentiality']
  /** Best-effort workspace trust for the resolved base agent, run as the
   *  boundary's pre-admission preflight OUTSIDE the coordinator. A throw maps to
   *  trust_preflight_failed with no admission record and the reservation freed. */
  markWorkspaceTrusted?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  /** Provider env preparation, OUTSIDE the coordinator; same failure mapping. */
  prepareEnv?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  /** Injectable total resolver for tests; defaults to the real one. */
  resolve?: typeof resolveAgentLaunch
}

/** The immutable per-creation context shared by both stages. `provisionalPaths`
 *  seed the pre-git resolve (variable NAMES validate, values are provisional);
 *  `authoritativePaths` are the real repo/worktree paths after git created the
 *  workspace. */
export type WorktreeAgentLaunchContext = {
  request: AgentLaunchSpawnRequest
  intent: LaunchIntent
  descriptor: AgentLaunchHostDescriptor
  scope: string
  /** Target worktree for the per-worktree admission cap (G6). Set on the
   *  stage-2/execute context — the create path knows its worktree only after
   *  git — and on retry contexts, where scope may be an attempt id instead. */
  worktreeId?: string | null
  principal: AdmissionPrincipal
}

function toSpawnDeps(deps: WorktreeAgentLaunchDeps): {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  boundary: AgentLaunchBoundary
  resolve?: typeof resolveAgentLaunch
} {
  return {
    getSettings: deps.getSettings,
    getCatalogRevision: deps.getCatalogRevision,
    boundary: deps.boundary,
    ...(deps.resolve ? { resolve: deps.resolve } : {})
  }
}

/** Stage 1: pin identity + config-only digest and reserve capacity, all before
 *  git mutation. On failure NO reservation is held and the caller must not
 *  create the worktree. */
export async function prepareWorktreeAgentLaunch(
  deps: WorktreeAgentLaunchDeps,
  context: WorktreeAgentLaunchContext,
  provisionalPaths: { repoPath: string | null; worktreePath: string | null }
): Promise<PrepareReservedAgentLaunchResult> {
  const detectionBaseAgents = detectionBaseAgentsForLaunch(context.request)
  const hostState = await deriveAgentLaunchHostState(
    {
      getSettings: deps.getSettings,
      getCatalogRevision: deps.getCatalogRevision,
      detectStockBaseAgents: deps.detectStockBaseAgents,
      resolveTargetHomePath: deps.resolveTargetHomePath,
      ...(deps.resolveStartupShell ? { resolveStartupShell: deps.resolveStartupShell } : {}),
      ...(deps.resolveTransportConfidentiality
        ? { resolveTransportConfidentiality: deps.resolveTransportConfidentiality }
        : {})
    },
    context.descriptor,
    provisionalPaths,
    detectionBaseAgents === undefined ? {} : { detectionBaseAgents }
  )
  const resolve = buildHostStateResolve(toSpawnDeps(deps), {
    request: context.request,
    intent: context.intent,
    target: hostState.target,
    variables: hostState.variables,
    scope: context.scope,
    principal: context.principal
  })
  return deps.boundary.prepareReservedAgentLaunch({ principal: context.principal, resolve })
}

/** Stage 2: with the authoritative worktree path and the pinned reservation,
 *  re-resolve, recheck the config-only digest, and convert the reservation into
 *  a startup plan + receipt (or release it on any rejection). Creates no PTY: the
 *  caller persists the pending record, then spawns and settles. */
export async function executeWorktreeAgentLaunch(
  deps: WorktreeAgentLaunchDeps,
  context: WorktreeAgentLaunchContext,
  authoritativePaths: { repoPath: string | null; worktreePath: string | null },
  reservation: { reservationId: string; expectedStableInputDigest: string }
): Promise<ExecuteAgentLaunchResult> {
  try {
    const detectionBaseAgents = detectionBaseAgentsForLaunch(context.request)
    const hostState = await deriveAgentLaunchHostState(
      {
        getSettings: deps.getSettings,
        getCatalogRevision: deps.getCatalogRevision,
        detectStockBaseAgents: deps.detectStockBaseAgents,
        resolveTargetHomePath: deps.resolveTargetHomePath,
        ...(deps.resolveStartupShell ? { resolveStartupShell: deps.resolveStartupShell } : {}),
        ...(deps.resolveTransportConfidentiality
          ? { resolveTransportConfidentiality: deps.resolveTransportConfidentiality }
          : {})
      },
      context.descriptor,
      authoritativePaths,
      detectionBaseAgents === undefined ? {} : { detectionBaseAgents }
    )
    const resolve = buildHostStateResolve(toSpawnDeps(deps), {
      request: context.request,
      intent: context.intent,
      target: hostState.target,
      variables: hostState.variables,
      scope: context.scope,
      principal: context.principal
    })
    return await deps.boundary.executeReservedAgentLaunch({
      scope: context.scope,
      // Stage 2 holds the authoritative worktree; a background intent names it
      // even when the caller did not thread context.worktreeId explicitly.
      worktreeId:
        context.worktreeId !== undefined
          ? context.worktreeId
          : context.intent.kind === 'background'
            ? context.intent.worktreeId
            : null,
      principal: context.principal,
      resolve,
      prompt: context.request.prompt ?? '',
      ...(context.request.allowEmptyPromptLaunch !== undefined
        ? { allowEmptyPromptLaunch: context.request.allowEmptyPromptLaunch }
        : {}),
      ...(context.request.promptDelivery !== undefined
        ? { promptDelivery: context.request.promptDelivery }
        : {}),
      maxInlineDraftChars: STARTUP_COMMAND_TEXT_MAX_CHARS,
      ...(deps.markWorkspaceTrusted ? { preflight: deps.markWorkspaceTrusted } : {}),
      ...(deps.prepareEnv ? { prepareEnv: deps.prepareEnv } : {}),
      reservationId: reservation.reservationId,
      expectedStableInputDigest: reservation.expectedStableInputDigest
    })
  } catch {
    // The stage-2 host reads (SSH/WSL detection + home probe) happen before the
    // boundary's guarded release path, so a disconnect rejecting here would
    // strand the pre-git hold until restart and repeated races would exhaust
    // capacity. Releasing is idempotent, so a hold the boundary already freed is
    // unaffected.
    deps.boundary.releaseReservedAgentLaunch(reservation.reservationId)
    return { ok: false, failure: { code: 'spawn_failed' } }
  }
}
