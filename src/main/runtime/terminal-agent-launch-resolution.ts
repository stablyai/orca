// Host resolution of a runtime terminal's `agentLaunch` request (U3). Wraps the
// shared host-state derivation and launch boundary for the terminal-create
// surfaces (terminal.create, session.tabs.createTerminal): it injects on-demand
// stock detection and the target home per execution host, marks workspace trust
// through the boundary's pre-admission preflight hook (driven by the resolved
// policy.preflightTrust, best-effort), and maps the admitted plan to the terminal
// option fields the spawn path consumes. The client's command/env/launchConfig/
// launchAgent are IGNORED here — this is a security boundary on the untrusted RPC
// surface: only the host-resolved plan spawns. Electron-free and injection-based
// so it is unit-testable.

import type { BuiltInTuiAgent, GlobalSettings, Repo } from '../../shared/types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'
import type {
  AgentLaunchInput,
  AgentLaunchSpawnOutcome,
  AgentLaunchSpawnRequest
} from '../../shared/agent-launch-spawn-request'
import type {
  AgentLaunchSnapshot,
  LaunchIntent,
  ResolvedAgentLaunch
} from '../../shared/agent-launch-host-contract'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import {
  detectionBaseAgentsForLaunch,
  deriveAgentLaunchHostState,
  type AgentLaunchHostDescriptor
} from '../agent-launch/agent-launch-host-state'
import { resolveAgentLaunchSpawn } from '../agent-launch/agent-launch-spawn'
import { resolveResumeLaunchIngest } from '../agent-launch/agent-launch-resume-ingest'
import type { AgentSessionRecordStore } from '../agent-launch/agent-session-record-store'
import type { resolveAgentLaunch } from '../agent-launch/resolve-agent-launch'
import type {
  AgentLaunchBoundary,
  AuthenticatedClientKind
} from '../agent-launch/agent-launch-boundary'
import { mapClientKindToLaunchClient } from '../agent-launch/agent-launch-boundary'
import type { AdmissionPrincipal } from '../agent-launch/agent-launch-admission-store'

/** The host-resolved fields a terminal spawn consumes. The launchAgent is the
 *  BUILT-IN base (expectedProcess/telemetry are built-in-keyed); the requested
 *  identity travels in the receipt. */
export type ResolvedTerminalLaunchFields = {
  command: string
  env?: Record<string, string>
  launchConfig: SleepingAgentLaunchConfig
  launchAgent: BuiltInTuiAgent
  launchToken: string
  startupCommandDelivery?: StartupCommandDelivery
  /** Post-ready prompt delivery for a host-spawned terminal (U7): a stdin-after-
   *  start followup is submitted; a no-native-affordance draft is pasted
   *  unsubmitted. Command-deliverable launches (argv/flag/env) carry neither.
   *  Present only when the resolved plan retained post-ready text — the host owns
   *  delivery via the readiness writers, never the client. */
  postReadyPrompt?: ResolvedTerminalPostReadyPrompt
}

export type ResolvedTerminalPostReadyPrompt = {
  expectedProcess: string
  followupPrompt?: string
  draftPrompt?: string
}

/** A pre-spawn typed failure/rejection: NO terminal is created and — for the RPC
 *  surfaces — this is a successful response, not an error envelope. */
export type TerminalAgentLaunchFailure = Extract<
  AgentLaunchSpawnOutcome,
  { status: 'failed' | 'rejected' }
>

export type TerminalAgentLaunchResolution =
  | {
      kind: 'resolved'
      fields: ResolvedTerminalLaunchFields
      admissionToken: string
      receipt: AgentLaunchReceipt
    }
  | { kind: 'failed'; outcome: TerminalAgentLaunchFailure }

export type TerminalAgentLaunchDeps = {
  boundary: AgentLaunchBoundary
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  detectStockBaseAgents: (
    descriptor: AgentLaunchHostDescriptor,
    baseAgents?: readonly BuiltInTuiAgent[]
  ) => Promise<readonly string[] | null>
  resolveTargetHomePath: (descriptor: AgentLaunchHostDescriptor) => Promise<string | null>
  resolveStartupShell?: (
    descriptor: AgentLaunchHostDescriptor
  ) => Promise<AgentStartupShell | undefined>
  /** Best-effort workspace trust for the resolved base agent, run as the
   *  boundary's pre-admission preflight. Must not throw for a routine no-trust
   *  agent; a throw maps to trust_preflight_failed with no admission record. */
  markWorkspaceTrusted: (launch: ResolvedAgentLaunch) => Promise<void> | void
  /** The host-private record store a resume/fork request resolves against. */
  sessionRecordStore: AgentSessionRecordStore
  /** Injectable total resolver for tests; defaults to the real one. */
  resolve?: typeof resolveAgentLaunch
}

export type TerminalAgentLaunchArgs = {
  /** A fresh selection launch or a provider-session resume/fork by session key. */
  request: AgentLaunchInput
  clientKind: AuthenticatedClientKind
  descriptor: AgentLaunchHostDescriptor
  scope: string
  worktreePath: string | null
  repoPath: string | null
  /** Host-trusted repo overrides for a source-control-recipe sourceRecord lookup
   *  (U7). Derived from the launch's target workspace by the runtime caller, never
   *  client-supplied; absent falls back to the global recipe. */
  recipeRepo?: Pick<Repo, 'sourceControlAi'> | null
  principal: AdmissionPrincipal
}

/** The resume-specific launch inputs merged with host-context target/variables. */
type TerminalSpawnInput = {
  request: AgentLaunchSpawnRequest
  intent: LaunchIntent
  persistedSnapshot?: AgentLaunchSnapshot
  resumeProviderSession?: AgentProviderSessionMetadata
}

/** Map the client agentLaunch input to the spawn input: a resume/fork loads the
 *  private record by session key (never forwarding a client launch config, so
 *  mobile/paired legacy replay finds no record → invalid_launch_snapshot); a fresh
 *  selection builds an interactive intent host-side. */
function resolveTerminalSpawnInput(
  args: TerminalAgentLaunchArgs,
  sessionRecordStore: AgentSessionRecordStore
):
  | { ok: true; input: TerminalSpawnInput }
  | { ok: false; failure: { code: 'invalid_launch_snapshot' } } {
  const client = mapClientKindToLaunchClient(args.clientKind)
  if ('resume' in args.request) {
    // No legacy context is forwarded on this untrusted RPC surface, so opaque
    // legacy replay never resolves here — a legacy record fails closed, exactly
    // as the migration rules require for mobile/paired-initiated resumes.
    const ingest = resolveResumeLaunchIngest(
      { resume: args.request.resume, client },
      sessionRecordStore
    )
    if (!ingest.ok || ingest.kind !== 'snapshot') {
      return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
    }
    return {
      ok: true,
      input: {
        request: ingest.request,
        intent: ingest.intent,
        persistedSnapshot: ingest.persistedSnapshot,
        resumeProviderSession: ingest.resumeProviderSession
      }
    }
  }
  if ('vaultResume' in args.request) {
    // AI Vault resume bypasses the resolver (like legacy replay): the runtime
    // intercepts it upstream in resolveWorkspaceAgentLaunch (copy → the dedicated
    // command method, resume → host-assembled bypass). Reaching the resolver means
    // a misroute, so fail closed rather than treating it as a fresh selection.
    return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
  }
  return {
    ok: true,
    input: { request: args.request, intent: { kind: 'interactive', client } }
  }
}

/** Resolve a terminal `agentLaunch` request into host-resolved spawn fields plus
 *  the admission token (settle after registration) and receipt, or a typed
 *  failure. Creates no terminal: the caller owns spawning + settlement. */
export async function resolveTerminalAgentLaunch(
  deps: TerminalAgentLaunchDeps,
  args: TerminalAgentLaunchArgs
): Promise<TerminalAgentLaunchResolution> {
  const spawnInput = resolveTerminalSpawnInput(args, deps.sessionRecordStore)
  if (!spawnInput.ok) {
    return { kind: 'failed', outcome: { status: 'failed', failure: spawnInput.failure } }
  }
  const detectionBaseAgents = detectionBaseAgentsForLaunch(
    spawnInput.input.request,
    spawnInput.input.persistedSnapshot
  )
  const hostState = await deriveAgentLaunchHostState(
    {
      getSettings: deps.getSettings,
      getCatalogRevision: deps.getCatalogRevision,
      detectStockBaseAgents: deps.detectStockBaseAgents,
      resolveTargetHomePath: deps.resolveTargetHomePath,
      ...(deps.resolveStartupShell ? { resolveStartupShell: deps.resolveStartupShell } : {})
    },
    args.descriptor,
    { worktreePath: args.worktreePath, repoPath: args.repoPath },
    detectionBaseAgents === undefined ? {} : { detectionBaseAgents }
  )
  const resolution = await resolveAgentLaunchSpawn(
    {
      getSettings: hostState.getSettings,
      getCatalogRevision: hostState.getCatalogRevision,
      boundary: deps.boundary,
      preflight: deps.markWorkspaceTrusted,
      ...(deps.resolve ? { resolve: deps.resolve } : {})
    },
    {
      request: spawnInput.input.request,
      intent: spawnInput.input.intent,
      target: hostState.target,
      variables: hostState.variables,
      scope: args.scope,
      principal: args.principal,
      ...(args.recipeRepo !== undefined ? { recipeRepo: args.recipeRepo } : {}),
      ...(spawnInput.input.persistedSnapshot
        ? { persistedSnapshot: spawnInput.input.persistedSnapshot }
        : {}),
      ...(spawnInput.input.resumeProviderSession
        ? { resumeProviderSession: spawnInput.input.resumeProviderSession }
        : {})
    }
  )
  if (!resolution.ok) {
    return {
      kind: 'failed',
      outcome:
        'failure' in resolution
          ? { status: 'failed', failure: resolution.failure }
          : { status: 'rejected', requestError: resolution.requestError }
    }
  }
  return {
    kind: 'resolved',
    admissionToken: resolution.receipt.launchToken,
    receipt: resolution.receipt,
    fields: {
      command: resolution.plan.launchCommand,
      ...(resolution.plan.env ? { env: resolution.plan.env } : {}),
      launchConfig: resolution.plan.launchConfig,
      launchAgent: resolution.receipt.baseAgent,
      launchToken: resolution.receipt.launchToken,
      ...(resolution.plan.startupCommandDelivery !== undefined
        ? { startupCommandDelivery: resolution.plan.startupCommandDelivery }
        : {}),
      ...(resolution.plan.followupPrompt || resolution.plan.draftPrompt
        ? {
            postReadyPrompt: {
              expectedProcess: resolution.plan.expectedProcess,
              ...(resolution.plan.followupPrompt
                ? { followupPrompt: resolution.plan.followupPrompt }
                : {}),
              ...(resolution.plan.draftPrompt ? { draftPrompt: resolution.plan.draftPrompt } : {})
            }
          }
        : {})
    }
  }
}
