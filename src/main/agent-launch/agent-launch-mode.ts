/**
 * Which surface a launch gets — a structured chat session or a terminal agent — decided from the
 * caller's explicit pick, else the user's own settings, and the executing host's answer.
 *
 * A caller may name the surface (`agent.launch`'s `surface`). Without one, the user's default
 * applies to every launch: an orchestration worker, a mobile create, a CLI create, a renderer tab.
 * That default is a preference rather than a demand, so a launch it cannot apply to falls back to a
 * PTY terminal and the receipt says which mode ran and why — a routine launch must never fail
 * because the user happens to have a chat preference on. An explicit chat is a demand: one this
 * host conclusively refuses before launch effects is rejected. A created workspace keeps its
 * terminal fallback.
 *
 * The settings default and the per-launch feasibility both come from
 * `shared/structured-native-chat-launch-route`. This module supplies placement facts and formats
 * the receipt; it does not own a second feasibility policy.
 *
 * Callers differ only in what they call the thing being started, so the receipt's noun is
 * parameterized. Orchestration says "worker" because its receipts are read alongside dispatch
 * records; every other surface says "chat session" / "terminal agent".
 */

import { requestsCwdOutsideWorkspaceRoot } from '../../shared/terminal-startup-cwd'
import type {
  AgentLaunchMode,
  AgentLaunchModeReason,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch-intent'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/structured-agent-runtime-metadata'
import {
  isNativeChatDefaultFor,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../shared/workspace-launch-kind'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentLaunchSurface } from '../../shared/agent-launch-surface'
import { formatAgentTypeLabel } from '../../shared/agent-type-label'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'

// The receipt is part of the launch contract, so it is declared with the rest of it; re-exported
// here because this module is where the decision that fills it lives.
export type { AgentLaunchMode, AgentLaunchModeReason, AgentLaunchModeReceipt }

type AgentLaunchDowngradeReason = Exclude<AgentLaunchModeReason, 'user_default' | 'requested'>

/** What this caller calls the thing it is starting, so one decision serves every surface without
 *  a receipt reading "worker" on a phone. */
export type AgentLaunchModeVocabulary = {
  /** e.g. 'a structured chat session worker' */
  structured: string
  /** e.g. 'a terminal agent worker' */
  terminal: string
  /** Per-reason wording a surface states differently. Orchestration names the `--terminal` flag
   *  in its reused-terminal detail, which would be meaningless in a phone's receipt. */
  detailOverrides?: Partial<Record<AgentLaunchDowngradeReason, string>>
}

export const DEFAULT_LAUNCH_VOCABULARY: AgentLaunchModeVocabulary = {
  structured: 'a structured chat session',
  terminal: 'a terminal agent'
}

export type AgentLaunchModeSettings = Partial<NativeChatDefaultSettings>

/** The placement facts the decision reads. `worktree`, `model` and `effort` are deliberately not
 *  here: a structured launch honours all three, and a placement flag must never imply a mode. */
export type AgentLaunchModePlacement = {
  agent?: string
  /** A connected execution server; absent means local. */
  on?: string
  /** An existing terminal being reused. */
  terminal?: string
  /** Which kind of workspace the launch lands in, derived by the host from the workspace it
   *  resolved — never accepted from a caller, which would let one route around this decision.
   *  Absent means the kind was never established, and is not read as any particular kind. */
  workspaceKind?: WorkspaceLaunchKind
  /** A requested start directory. It belongs here, unlike `model` or `effort`, because a structured
   *  session has no way to apply one — it runs in its workspace — so honouring it and honouring the
   *  chat preference are mutually exclusive rather than merely awkward. Read against
   *  `workspacePath`: a cwd that names the root asks for nothing and decides nothing. */
  cwd?: string
  /** The root of the workspace the launch lands in, when the host has resolved it. Without it a
   *  requested `cwd` remains unresolved until materialization. */
  workspacePath?: string
  /** False when the client asking for the launch cannot show this agent's chat; absent for the
   *  host's own callers, which can. */
  callerRendersStructured?: boolean
}

const REGISTERED_STRUCTURED_AGENTS: readonly string[] = STRUCTURED_AGENT_RUNTIME_METADATA.map(
  ({ definition }) => definition.agent
)

const DOWNGRADE_DETAIL: Record<AgentLaunchDowngradeReason, string> = {
  remote_execution_host: 'this launch runs on a remote execution host',
  reused_terminal: 'it reuses a running terminal agent',
  agent_without_structured_session: 'this agent has no structured session',
  tui_launch_command: 'it asks to start in a folder other than its workspace',
  structured_sessions_unavailable: 'this runtime does not support structured agent sessions',
  structured_support_unknown: 'the execution host has not established structured session support',
  wsl_execution_runtime: 'this workspace runs under WSL',
  codex_on_windows: 'Codex has no structured session on Windows',
  structured_unsupported_on_host: 'the execution host cannot create one here'
}

const BLOCKER_REASON: Record<StructuredNativeChatBlocker, AgentLaunchDowngradeReason> = {
  'reused-terminal': 'reused_terminal',
  'agent-without-structured-session': 'agent_without_structured_session',
  'custom-start-directory': 'tui_launch_command',
  'remote-execution-host': 'remote_execution_host',
  'project-runtime': 'wsl_execution_runtime',
  'runtime-capability': 'structured_sessions_unavailable',
  'runtime-capability-unknown': 'structured_support_unknown',
  'client-capability': 'structured_sessions_unavailable'
}

/** The host's own create-support verdict (`agentSession.createSupport`) in this vocabulary. */
const HOST_SUPPORT_REASON: Record<'agent' | 'remote' | 'wsl', AgentLaunchDowngradeReason> = {
  agent: 'structured_unsupported_on_host',
  remote: 'remote_execution_host',
  wsl: 'wsl_execution_runtime'
}

/**
 * First half of the decision: the user's default, plus every feasibility fact knowable before a
 * workspace is resolved.
 */
export function decideAgentLaunchMode(args: {
  placement: AgentLaunchModePlacement
  settings: AgentLaunchModeSettings | null | undefined
  /** Host-internal: the caller's contract is a terminal handle, so the chat default cannot apply. */
  terminalOnly?: boolean
  /** The caller's explicit pick, which replaces the settings default for this launch. */
  surface?: AgentLaunchSurface
  vocabulary?: AgentLaunchModeVocabulary
}): AgentLaunchModeReceipt {
  const { placement, settings, surface } = args
  const vocabulary = args.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unrecognized agent name is handled rather than trusted; the registered-agent check rejects it and the launch downgrades to a terminal.
  const agent = placement.agent as TuiAgent
  if (surface === 'terminal' && !args.terminalOnly) {
    return {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'requested',
      detail: `Started ${vocabulary.terminal}, as requested.`
    }
  }
  const blocked = (reason: AgentLaunchDowngradeReason): AgentLaunchModeReceipt =>
    unavailableLaunchMode(reason, vocabulary, surface === 'chat', {
      agent,
      phase: 'before-effects'
    })
  if (args.terminalOnly || (surface !== 'chat' && !isNativeChatDefaultFor(settings, agent))) {
    return {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: `Started ${vocabulary.terminal}, the default for new agent tabs in your settings.`
    }
  }
  // A worker placed on another runtime starts through federation, which creates terminal agents
  // only; this host cannot answer for that runtime's structured support.
  if (placement.on) {
    return blocked('remote_execution_host')
  }
  const cwdRelation = launchCwdRelation(placement)
  const support = resolveStructuredNativeChatSupport({
    agent,
    executionHostId: 'local',
    reusesTerminal: Boolean(placement.terminal),
    hostCapabilities: RUNTIME_CAPABILITIES,
    // This host is the one that will run the agent, so its own registrations answer.
    hostStructuredAgents: REGISTERED_STRUCTURED_AGENTS,
    // The host resolves the floating workspace to its configured directory; create-support still
    // answers for the resolved workspace, including whether it uses WSL.
    ...(placement.workspaceKind ? { workspaceKind: placement.workspaceKind } : {}),
    // Mirrors the renderer's own route input (`agent-launch-route-input.ts`): a cwd is terminal-only
    // when it names somewhere other than the workspace root, by the same shared rule.
    startsOutsideWorkspaceRoot:
      cwdRelation === 'custom' || (surface !== 'chat' && cwdRelation === 'unknown')
  })
  if (!support.supported) {
    return blocked(BLOCKER_REASON[support.blocker])
  }
  // A chat its caller can neither show nor close is no launch; that caller gets the terminal.
  if (placement.callerRendersStructured === false) {
    return blocked(BLOCKER_REASON['client-capability'])
  }
  return surface === 'chat'
    ? {
        mode: 'structured',
        preferred: 'structured',
        reason: 'requested',
        detail: `Started ${vocabulary.structured}, as requested.`
      }
    : {
        mode: 'structured',
        preferred: 'structured',
        reason: 'user_default',
        detail: `Started ${vocabulary.structured}, the default for new agent tabs in your settings.`
      }
}

/**
 * Second half, once the workspace is resolved: the host that will run the agent answers whether it
 * can create a structured session there. Only a conclusive refusal before launch effects can
 * reject an explicit chat; a materialized workspace retains its terminal fallback.
 */
export async function resolveAgentLaunchModeOnHost(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  receipt: AgentLaunchModeReceipt,
  worktreeId: string | undefined,
  agent: TuiAgent | undefined,
  vocabulary: AgentLaunchModeVocabulary = DEFAULT_LAUNCH_VOCABULARY,
  context?: AgentLaunchModeSettlement
): Promise<AgentLaunchModeReceipt> {
  if (receipt.mode !== 'structured' || !worktreeId) {
    return receipt
  }
  if (context && launchCwdRelation(context) !== 'root') {
    return unavailableLaunchMode(
      'tui_launch_command',
      vocabulary,
      receipt.reason === 'requested',
      {
        ...context,
        agent
      },
      launchCwdRelation(context) === 'custom'
    )
  }
  return downgradeAgentLaunchModeForHost(
    receipt,
    await readStructuredCreateSupport(runtime, worktreeId, agent),
    vocabulary,
    context ? { ...context, agent } : undefined
  )
}

/** A host that cannot answer has not proved it can create one, so the launch stays a PTY agent. */
async function readStructuredCreateSupport(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  worktreeId: string,
  agent: TuiAgent | undefined
): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null> {
  if (!agent || !REGISTERED_STRUCTURED_AGENTS.includes(agent)) {
    return { supported: false, reason: 'agent' }
  }
  try {
    return await runtime.getStructuredAgentSessionCreateSupport(`id:${worktreeId}`, agent)
  } catch {
    return null
  }
}

/**
 * Applies the executing host's `agentSession.createSupport` answer, which is the authority on WSL,
 * remoteness and per-agent support for the resolved workspace.
 */
export function downgradeAgentLaunchModeForHost(
  receipt: AgentLaunchModeReceipt,
  support: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null,
  vocabulary: AgentLaunchModeVocabulary = DEFAULT_LAUNCH_VOCABULARY,
  context?: AgentLaunchModeSettlement
): AgentLaunchModeReceipt {
  if (receipt.mode !== 'structured' || support?.supported) {
    return receipt
  }
  const requested = receipt.reason === 'requested'
  if (support === null) {
    return downgraded(BLOCKER_REASON['runtime-capability-unknown'], vocabulary, requested)
  }
  return unavailableLaunchMode(
    support.reason ? HOST_SUPPORT_REASON[support.reason] : 'structured_unsupported_on_host',
    vocabulary,
    requested,
    context
  )
}

export function downgradeAgentLaunchModeForStructuredRefusal(
  receipt: AgentLaunchModeReceipt,
  vocabulary: AgentLaunchModeVocabulary,
  context?: AgentLaunchModeSettlement
): AgentLaunchModeReceipt {
  const fallback = unavailableLaunchMode(
    'structured_unsupported_on_host',
    vocabulary,
    receipt.reason === 'requested',
    context
  )
  return {
    ...fallback,
    detail: `${receipt.reason === 'requested' ? 'You asked for' : 'Your default is'} a structured chat session, but the host refused to create one here; started ${vocabulary.terminal} instead.`
  }
}

/** Phase is derived from successful materialization, never from a support lookup's availability. */
export type AgentLaunchModeSettlement = {
  phase: 'before-effects' | 'created-workspace'
  agent?: TuiAgent
  workspacePath?: string
  cwd?: string
}

function launchCwdRelation(placement: Pick<AgentLaunchModePlacement, 'cwd' | 'workspacePath'>) {
  if (!placement.cwd?.trim()) {
    return 'root'
  }
  if (!placement.workspacePath) {
    return 'unknown'
  }
  return requestsCwdOutsideWorkspaceRoot(placement.workspacePath, placement.cwd) ? 'custom' : 'root'
}

function unavailableLaunchMode(
  reason: AgentLaunchDowngradeReason,
  vocabulary: AgentLaunchModeVocabulary,
  requested: boolean,
  context?: AgentLaunchModeSettlement,
  conclusive = true
): AgentLaunchModeReceipt {
  if (requested && conclusive && context?.phase === 'before-effects') {
    throw new AgentLaunchSurfaceUnavailableError(
      `${formatAgentTypeLabel(context.agent)} can't open as a chat here because ${DOWNGRADE_DETAIL[reason]}. Start it in a terminal instead.`
    )
  }
  return downgraded(reason, vocabulary, requested)
}

function downgraded(
  reason: AgentLaunchDowngradeReason,
  vocabulary: AgentLaunchModeVocabulary,
  requested = false
): AgentLaunchModeReceipt {
  const why = vocabulary.detailOverrides?.[reason] ?? DOWNGRADE_DETAIL[reason]
  return {
    mode: 'terminal',
    preferred: 'structured',
    reason,
    detail: `${requested ? 'You asked for' : 'Your default is'} a structured chat session, but ${why}; started ${vocabulary.terminal} instead.`
  }
}

/** One main-log line when a launch the user's default asked to be a chat opened a terminal. */
export function warnStructuredLaunchDowngrade(
  agent: string,
  receipt: AgentLaunchModeReceipt
): void {
  if (receipt.mode === 'terminal' && receipt.preferred === 'structured') {
    console.warn(`[agent-launch] ${agent} opened a terminal: ${receipt.reason}`)
  }
}

/** Read private saved choices; a desktop stamp already resolved the preference for this agent. */
export function readAgentLaunchModeSettings(
  runtime: { requireStore(): { getSettings(): AgentLaunchModeSettings | null } },
  nativeChatDefault?: boolean
): AgentLaunchModeSettings | null {
  if (nativeChatDefault !== undefined) {
    return { experimentalNativeChat: nativeChatDefault }
  }
  try {
    return runtime.requireStore().getSettings()
  } catch (error) {
    console.warn('[agent-launch] could not resolve chat preference', error)
    return null
  }
}
