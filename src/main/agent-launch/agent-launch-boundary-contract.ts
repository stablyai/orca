// Request/result contract for the agent-launch host boundary (U3/U4). Split from
// agent-launch-boundary.ts so the boundary class stays within the module size
// budget; the boundary re-exports these, so existing importers are unaffected.

import type { AdmissionPrincipal } from './agent-launch-admission-store'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import type { ResolvedAgentLaunch } from '../../shared/agent-launch-host-contract'
import type {
  AgentLaunchFailure,
  AgentLaunchNotice,
  AgentLaunchReceipt,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import { buildAgentStartupPlanFromResolvedLaunch } from '../../shared/resolved-agent-startup-plan'

/** Collapse duplicate notice codes so a receipt carries each notice once. */
export function dedupeNoticesByCode(notices: readonly AgentLaunchNotice[]): AgentLaunchNotice[] {
  const seen = new Set<string>()
  const deduped: AgentLaunchNotice[] = []
  for (const notice of notices) {
    if (!seen.has(notice.code)) {
      seen.add(notice.code)
      deduped.push(notice)
    }
  }
  return deduped
}

/** Map a re-resolve mismatch inside the coordinator: a newly disabled base is
 *  base_agent_disabled; any other relevant change is agent_configuration_changed.
 *  The fingerprint only hashes relevant inputs, so an unrelated catalog edit does
 *  not reach this path. */
export function mapAdmissionMismatch(failure: AgentLaunchFailure): AgentLaunchFailure {
  if (failure.code === 'base_agent_disabled') {
    return failure
  }
  return {
    code: 'agent_configuration_changed',
    ...(failure.requestedAgent ? { requestedAgent: failure.requestedAgent } : {}),
    ...(failure.baseAgent ? { baseAgent: failure.baseAgent } : {})
  }
}

/** The client-safe identity pair carried on failures/receipts. */
export function agentIds(launch: ResolvedAgentLaunch): {
  requestedAgent: ResolvedAgentLaunch['requestedAgent']
  baseAgent: ResolvedAgentLaunch['baseAgent']
} {
  return { requestedAgent: launch.requestedAgent, baseAgent: launch.baseAgent }
}

/** Authenticated RPC client kind. `undefined` is an in-process/host caller —
 *  desktop, never mobile by guesswork. Never copied from client JSON. */
export type AuthenticatedClientKind = 'runtime' | 'mobile' | undefined

/** Map the authenticated RPC scope to the launch-intent client. Callers build
 *  their interactive/resume LaunchIntent host-side with this — the boundary's
 *  intent construction lives here so no path derives it from client payload. */
export function mapClientKindToLaunchClient(
  kind: AuthenticatedClientKind
): 'desktop' | 'paired-web' | 'mobile' {
  if (kind === 'runtime') {
    return 'paired-web'
  }
  if (kind === 'mobile') {
    return 'mobile'
  }
  return 'desktop'
}

/** One resolution against the current atomic host state view (settings +
 *  normalized catalog + detection snapshot + derived target). The caller closes
 *  over the fixed request (selection/intent/reference/variables/target) and
 *  re-reads volatile host state on each call; it performs no async I/O so it is
 *  safe to invoke inside the coordinator's critical section. */
export type HostStateResolution = {
  outcome: ResolveAgentLaunchOutcome
  catalogRevision: number
}

export type ExecuteAgentLaunchArgs = {
  /** Owner scope for reconciliation joins (worktree id, pane key, run id …). */
  scope: string
  /** Target worktree for the per-worktree admission cap. Omit/null when the
   *  launch names no worktree (the scope already IS the worktree for interactive
   *  worktree launches, but unattended launches scope by run/dispatch/attempt id
   *  and must name the worktree separately). */
  worktreeId?: string | null
  principal: AdmissionPrincipal
  /** Re-resolve from a fresh atomic host view. Called once before admission and
   *  once inside the coordinator; both re-read settings. */
  resolve: () => HostStateResolution
  prompt: string
  allowEmptyPromptLaunch?: boolean
  /** 'draft' lands the prompt unsubmitted; default 'submit'. */
  promptDelivery?: 'submit' | 'draft'
  /** Inline draft-flag command ceiling (STARTUP_COMMAND_TEXT_MAX_CHARS), threaded
   *  from the provider layer so the shared plan builder stays main-free. */
  maxInlineDraftChars?: number
  /** Trust preflight, OUTSIDE the coordinator. A throw maps to
   *  trust_preflight_failed and commits no admission record. */
  preflight?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  /** Provider env preparation, OUTSIDE the coordinator. Same failure mapping as
   *  preflight: a pre-spawn preparation throw is a trust_preflight_failed with
   *  no admission record (no dedicated failure code exists for this phase). */
  prepareEnv?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  now?: () => number
}

export type ExecuteAgentLaunchResult =
  | { ok: true; plan: AgentStartupPlan; receipt: AgentLaunchReceipt }
  | { ok: false; failure: AgentLaunchFailure }
  | { ok: false; requestError: AgentLaunchRequestError }

/** Resolve-only startup-plan request for the legacy renderer-spawned worktree-
 *  create path. It resolves once against the atomic host view and builds a plan,
 *  but takes NO admission token — that path registers no terminal receipt and has
 *  no settle seam, so an admitted hold would leak capacity forever. */
export type ResolveAgentLaunchPlanArgs = {
  resolve: () => HostStateResolution
  prompt: string
  allowEmptyPromptLaunch?: boolean
  promptDelivery?: 'submit' | 'draft'
  maxInlineDraftChars?: number
}

export type ResolveAgentLaunchPlanResult =
  | { ok: true; plan: AgentStartupPlan }
  | { ok: false; failure: AgentLaunchFailure }
  | { ok: false; requestError: AgentLaunchRequestError }

/** Resolve once and build a startup plan without admitting. Extracted from the
 *  boundary class because it holds no admission/coordinator state — it is the
 *  legacy path's whole pipeline. */
export function resolveAgentLaunchPlanWithoutAdmission(
  args: ResolveAgentLaunchPlanArgs
): ResolveAgentLaunchPlanResult {
  const resolution = args.resolve()
  if (!resolution.outcome.ok) {
    if ('requestError' in resolution.outcome) {
      return { ok: false, requestError: resolution.outcome.requestError }
    }
    return { ok: false, failure: resolution.outcome.failure }
  }
  const original = resolution.outcome.launch
  const plan = buildAgentStartupPlanFromResolvedLaunch({
    launch: original,
    prompt: args.prompt,
    ...(args.allowEmptyPromptLaunch !== undefined
      ? { allowEmptyPromptLaunch: args.allowEmptyPromptLaunch }
      : {}),
    ...(args.promptDelivery !== undefined ? { promptDelivery: args.promptDelivery } : {}),
    ...(args.maxInlineDraftChars !== undefined
      ? { maxInlineDraftChars: args.maxInlineDraftChars }
      : {})
    // No launchToken: nothing is admitted, so there is nothing to reconcile.
  })
  if (!plan) {
    return { ok: false, failure: { code: 'no_agent_selected', ...agentIds(original) } }
  }
  return { ok: true, plan }
}

export type PrepareReservedAgentLaunchArgs = {
  principal: AdmissionPrincipal
  /** Resolve selection (may be `default`) against the atomic host view with
   *  provisional variables — the worktree path is not yet authoritative. Only
   *  the pinned identity + config-only digest survive; the argv is discarded. */
  resolve: () => HostStateResolution
}

/** Pre-create outcome held across git mutation. The reservation must be
 *  converted by executeReservedAgentLaunch or dropped via releaseReservation on
 *  every pre-spawn exit; the caller owns that lifecycle. */
export type PrepareReservedAgentLaunchResult =
  | {
      ok: true
      reservationId: string
      requestedAgent: ResolvedAgentLaunch['requestedAgent']
      baseAgent: ResolvedAgentLaunch['baseAgent']
      stableInputDigest: string
    }
  | { ok: false; failure: AgentLaunchFailure }
  | { ok: false; requestError: AgentLaunchRequestError }

export type ExecuteReservedAgentLaunchArgs = ExecuteAgentLaunchArgs & {
  /** The hold taken by prepareReservedAgentLaunch. */
  reservationId: string
  /** The config-only digest pinned pre-create; a post-create mismatch means the
   *  definition/default/base changed across the git operation. */
  expectedStableInputDigest: string
}

/** Terminal outcome the caller boundary reports back so admission moves or
 *  releases: `registered` keeps a private reconciliation handoff record, while
 *  `failed` releases the reservation entirely. */
export type LaunchSettlement = 'registered' | 'failed'
