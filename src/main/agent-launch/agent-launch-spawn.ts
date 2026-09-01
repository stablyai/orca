// Host adapter that turns a client `agentLaunch` request into a resolved startup
// plan + receipt through the launch boundary (U3). The client request names only
// the agent identity and prompt: this module builds the ResolveAgentLaunchRequest
// entirely from HOST state (settings, normalized catalog, detection, derived
// target) and NEVER reads a client command/launchConfig/launchAgent/env — those
// fields have no representation in AgentLaunchSpawnInput. Intent is constructed
// host-side; the reference authority is derived here, not copied from the client.

import type { GlobalSettings, BuiltInTuiAgent, Repo } from '../../shared/types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchReceipt,
  AgentLaunchFailure,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type {
  AgentLaunchExecutionHostId,
  AgentLaunchSnapshot,
  AgentReferenceAuthority,
  LaunchIntent,
  ResolvedAgentLaunch
} from '../../shared/agent-launch-host-contract'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type {
  AgentLaunchSourceRecord,
  AgentLaunchSpawnRequest
} from '../../shared/agent-launch-spawn-request'
import { isSourceControlActionId } from '../../shared/source-control-ai-actions'
import { resolveSourceControlActionRecipe } from '../../shared/source-control-ai'
import { normalizeCatalogFromSettings } from './agent-catalog-projections'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import { STARTUP_COMMAND_TEXT_MAX_CHARS } from '../providers/windows-shell-args'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import type {
  AgentLaunchBoundary,
  HostStateResolution,
  ResolveAgentLaunchPlanResult
} from './agent-launch-boundary'
import type { AdmissionPrincipal } from './agent-launch-admission-store'

export type AgentLaunchSpawnTarget = {
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
  executionHostId: AgentLaunchExecutionHostId
  targetHomePath?: string | null
  /** null = detection unavailable (unknown); never claims "not installed". */
  detectedStockBaseAgents?: ReadonlySet<BuiltInTuiAgent> | null
  transportConfidentialityAvailable?: boolean
}

export type AgentLaunchSpawnDeps = {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  boundary: AgentLaunchBoundary
  preflight?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  prepareEnv?: (launch: ResolvedAgentLaunch) => Promise<void> | void
  /** Injectable for tests; defaults to the real total resolver. */
  resolve?: typeof resolveAgentLaunch
}

export type AgentLaunchSpawnInput = {
  request: AgentLaunchSpawnRequest
  intent: LaunchIntent
  target: AgentLaunchSpawnTarget
  variables: { repoPath?: string | null; worktreePath?: string | null }
  /** Host-trusted repo overrides for a source-control-recipe sourceRecord lookup
   *  (U7). Derived from the launch's worktree context, never client-supplied;
   *  absent falls back to the global recipe. */
  recipeRepo?: Pick<Repo, 'sourceControlAi'> | null
  scope: string
  /** Target worktree for the per-worktree admission cap (G6). The scope already
   *  IS the worktree for interactive worktree launches; unattended launches
   *  scope by run/dispatch/attempt id and must name the worktree here. */
  worktreeId?: string | null
  principal: AdmissionPrincipal
  persistedSnapshot?: AgentLaunchSnapshot
  /** Provider session for a resume/fork replay; drives the resolver's resume-argv
   *  append. Only the resume ingestion sets it. */
  resumeProviderSession?: AgentProviderSessionMetadata
}

export type AgentLaunchSpawnResolution =
  | { ok: true; plan: AgentStartupPlan; receipt: AgentLaunchReceipt }
  | { ok: false; failure: AgentLaunchFailure }
  | { ok: false; requestError: AgentLaunchRequestError }

/** The only sourceRecord owner a CLIENT-authored request may claim: the recipe
 *  id is host-validated (isSourceControlActionId, else untrusted_reference).
 *  Every other owner ('workspace', 'session', …) is host-constructed by the
 *  retry/resume ingestion paths from state the host already verified — a client
 *  echoing one would forge persisted fallback authority for a tombstoned or
 *  disabled id, bypassing the untrusted_reference gate. */
const CLIENT_CLAIMABLE_SOURCE_RECORD_OWNERS: ReadonlySet<AgentLaunchSourceRecord['owner']> =
  new Set(['source-control-recipe'])

/** Strip unverifiable persisted authority from a client-authored request BEFORE
 *  resolution, per the request schema's header: the host constructs authority
 *  from authenticated context, never from this payload. Apply at every seam
 *  where client JSON enters the launch pipeline; host-constructed requests
 *  (retry/resume) do not pass through this. */
export function sanitizeClientAgentLaunchSourceRecord(
  request: AgentLaunchSpawnRequest
): AgentLaunchSpawnRequest {
  if (
    !request.sourceRecord ||
    CLIENT_CLAIMABLE_SOURCE_RECORD_OWNERS.has(request.sourceRecord.owner)
  ) {
    return request
  }
  const { sourceRecord: _dropped, ...rest } = request
  return rest
}

/** Derive the reference authority host-side from the requested selection and any
 *  host-verified saved owner. A live selection cannot forge persisted fallback
 *  authority; that requires a validated sourceRecord owner. */
function referenceFor(request: AgentLaunchSpawnRequest): AgentReferenceAuthority {
  if (request.selection.kind === 'default') {
    return { kind: 'persisted', owner: 'default' }
  }
  if (request.sourceRecord) {
    return { kind: 'persisted', owner: request.sourceRecord.owner }
  }
  return { kind: 'live-selection' }
}

/** Resolve the host-owned per-launch args for a validated sourceRecord (U7). Only
 *  a source-control-recipe owner contributes args today: the host validates the id
 *  is a real action id (unknown/mismatched → untrusted_reference, no PTY), then
 *  reads the recipe's stored agentArgs from repo-scoped settings (global fallback
 *  when the repo id is absent). A client may substitute UNSAVED edits of those
 *  args (`unsavedAgentArgs`) for this one launch — still bounded text the resolver
 *  tokenizes itself, never a resolved argv — and the stored recipe stays the
 *  fallback. Clients never send anything else about the launch. */
function resolvePerLaunchArgs(
  request: AgentLaunchSpawnRequest,
  recipeRepo: Pick<Repo, 'sourceControlAi'> | null | undefined,
  settings: GlobalSettings
): { ok: true; perLaunchArgs?: string } | { ok: false; requestError: AgentLaunchRequestError } {
  const sourceRecord = request.sourceRecord
  if (!sourceRecord || sourceRecord.owner !== 'source-control-recipe') {
    return { ok: true }
  }
  if (!sourceRecord.id || !isSourceControlActionId(sourceRecord.id)) {
    return { ok: false, requestError: { code: 'untrusted_reference' } }
  }
  // Why: the unsaved edit IS the args the user launched with; the stored recipe
  // is a stale snapshot of them. An empty string is a real "no args" edit.
  if (request.unsavedAgentArgs !== undefined) {
    return { ok: true, perLaunchArgs: request.unsavedAgentArgs }
  }
  const recipe = resolveSourceControlActionRecipe({
    settings,
    repo: recipeRepo,
    actionId: sourceRecord.id
  })
  return recipe.agentArgs !== undefined
    ? { ok: true, perLaunchArgs: recipe.agentArgs }
    : { ok: true }
}

/** Normalized catalogs keyed by the settings object that produced them. The
 *  boundary re-invokes `resolve` 2-3 times per launch (initial, coordinator
 *  re-resolve, and the two-stage worktree pre/post-create pair) and the settings
 *  store REPLACES the settings object on every write — so an identical reference
 *  is proof the catalog inputs are unchanged and the O(n) normalize pass can be
 *  reused. A changed reference still re-normalizes, keeping the coordinator's
 *  agent_configuration_changed detection exact. Weak so a superseded settings
 *  revision's catalog is collectible. */
const normalizedCatalogBySettings = new WeakMap<GlobalSettings, AgentCatalog>()

function normalizedCatalogFor(settings: GlobalSettings): AgentCatalog {
  const cached = normalizedCatalogBySettings.get(settings)
  if (cached) {
    return cached
  }
  const catalog = normalizeCatalogFromSettings(settings)
  normalizedCatalogBySettings.set(settings, catalog)
  return catalog
}

/** Build the boundary's `resolve` closure from the surface deps + input. Each
 *  call re-reads live settings and the normalized catalog and runs the total
 *  resolver over the fixed request; it does no async I/O, so the boundary can
 *  re-invoke it inside the admission coordinator. Shared by the single-shot
 *  spawn path and U4's two-stage worktree transaction so both surfaces produce
 *  one canonical serialization/fingerprint. */
export function buildHostStateResolve(
  deps: AgentLaunchSpawnDeps,
  input: AgentLaunchSpawnInput
): () => HostStateResolution {
  const resolveFn = deps.resolve ?? resolveAgentLaunch
  const reference = referenceFor(input.request)
  return (): HostStateResolution => {
    const settings = deps.getSettings()
    const perLaunch = resolvePerLaunchArgs(input.request, input.recipeRepo, settings)
    if (!perLaunch.ok) {
      return {
        outcome: { ok: false, requestError: perLaunch.requestError },
        catalogRevision: deps.getCatalogRevision()
      }
    }
    const catalog = normalizedCatalogFor(settings)
    const outcome: ResolveAgentLaunchOutcome = resolveFn(
      {
        selection: input.request.selection,
        intent: input.intent,
        reference,
        variables: input.variables,
        ...(perLaunch.perLaunchArgs !== undefined
          ? { perLaunchArgs: perLaunch.perLaunchArgs }
          : {}),
        platform: input.target.platform,
        ...(input.target.shell ? { shell: input.target.shell } : {}),
        isRemote: input.target.isRemote,
        targetHomePath: input.target.targetHomePath ?? null,
        detectedStockBaseAgents: input.target.detectedStockBaseAgents ?? null,
        executionHostId: input.target.executionHostId,
        ...(input.target.transportConfidentialityAvailable !== undefined
          ? { transportConfidentialityAvailable: input.target.transportConfidentialityAvailable }
          : {}),
        ...(input.persistedSnapshot ? { persistedSnapshot: input.persistedSnapshot } : {}),
        ...(input.resumeProviderSession
          ? { resumeProviderSession: input.resumeProviderSession }
          : {})
      },
      catalog,
      settings
    )
    return { outcome, catalogRevision: deps.getCatalogRevision() }
  }
}

/** Resolve a legacy renderer-spawned startup request into a plan WITHOUT taking
 *  an admission token. Reuses the exact host-state resolve closure the admitted
 *  path builds, so the two share one serialization/fingerprint, but stops before
 *  admission because this path registers no terminal receipt (no settle seam) and
 *  a held token would leak capacity. One-release compatibility shim; removed with
 *  the startupAgent/startupDraft fields. */
export function resolveAgentLaunchStartupPlanWithoutAdmission(
  deps: AgentLaunchSpawnDeps,
  input: AgentLaunchSpawnInput
): ResolveAgentLaunchPlanResult {
  const resolve = buildHostStateResolve(deps, input)
  return deps.boundary.resolveAgentLaunchPlanWithoutAdmission({
    resolve,
    prompt: input.request.prompt ?? '',
    ...(input.request.allowEmptyPromptLaunch !== undefined
      ? { allowEmptyPromptLaunch: input.request.allowEmptyPromptLaunch }
      : {}),
    ...(input.request.promptDelivery !== undefined
      ? { promptDelivery: input.request.promptDelivery }
      : {}),
    maxInlineDraftChars: STARTUP_COMMAND_TEXT_MAX_CHARS
  })
}

/** Resolve a client agentLaunch request into a startup plan + receipt, or a
 *  typed failure/request-error. Creates no PTY: the caller owns spawning. */
export async function resolveAgentLaunchSpawn(
  deps: AgentLaunchSpawnDeps,
  input: AgentLaunchSpawnInput
): Promise<AgentLaunchSpawnResolution> {
  const resolve = buildHostStateResolve(deps, input)

  return deps.boundary.executeAgentLaunch({
    scope: input.scope,
    ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
    principal: input.principal,
    resolve,
    prompt: input.request.prompt ?? '',
    ...(input.request.allowEmptyPromptLaunch !== undefined
      ? { allowEmptyPromptLaunch: input.request.allowEmptyPromptLaunch }
      : {}),
    ...(input.request.promptDelivery !== undefined
      ? { promptDelivery: input.request.promptDelivery }
      : {}),
    // The shared plan builder is main-free, so the provider size ceiling is
    // threaded here rather than imported there.
    maxInlineDraftChars: STARTUP_COMMAND_TEXT_MAX_CHARS,
    ...(deps.preflight ? { preflight: deps.preflight } : {}),
    ...(deps.prepareEnv ? { prepareEnv: deps.prepareEnv } : {})
  })
}
