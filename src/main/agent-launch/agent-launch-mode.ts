/** Chat defaults may fall back; explicit chat is refused only conclusively before launch effects. */

import { requestsCwdOutsideWorkspaceRoot } from '../../shared/terminal-startup-cwd'
import type {
  AgentLaunchMode,
  AgentLaunchModeReason,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch-intent'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/structured-agent-runtime-metadata'
import {
  nativeChatPreferenceFor,
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

export type { AgentLaunchMode, AgentLaunchModeReason, AgentLaunchModeReceipt }

type AgentLaunchDowngradeReason = Exclude<AgentLaunchModeReason, 'user_default' | 'requested'>

/** Caller-specific receipt wording, shared across desktop, mobile and orchestration. */
export type AgentLaunchModeVocabulary = {
  structured: string
  terminal: string
  /** Override wording such as orchestration’s --terminal guidance for the calling surface. */
  detailOverrides?: Partial<Record<AgentLaunchDowngradeReason, string>>
}

export const DEFAULT_LAUNCH_VOCABULARY: AgentLaunchModeVocabulary = {
  structured: 'a structured chat session',
  terminal: 'a terminal agent'
}

export type AgentLaunchModeSettings = NativeChatDefaultSettings

export type AgentLaunchModePlacement = {
  agent?: string
  /** A connected execution server; absent means local. */
  on?: string
  terminal?: string
  /** Derived by the host; absent means unknown, not a default workspace kind. */
  workspaceKind?: WorkspaceLaunchKind
  /** Structured sessions cannot honor a cwd outside their workspace root. */
  cwd?: string
  /** Missing until materialization; a requested cwd cannot be classified without it. */
  workspacePath?: string
  /** False if the client cannot display this chat; host callers may omit it. */
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
  structured_unsupported_on_host: 'the execution host cannot create one here',
  chat_runtime_not_installed:
    "its chat runtime isn't installed on this host (install it from a new chat tab in Orca)"
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

type HostSupportReason = 'agent' | 'remote' | 'wsl' | 'chat-program'
type HostLaunchSupport = { supported: boolean; reason?: HostSupportReason }

const HOST_SUPPORT_REASON: Record<HostSupportReason, AgentLaunchDowngradeReason> = {
  agent: 'structured_unsupported_on_host',
  remote: 'remote_execution_host',
  wsl: 'wsl_execution_runtime',
  'chat-program': 'chat_runtime_not_installed'
}

/** Apply shared feasibility policy to facts available before resolving the workspace. */
export function decideAgentLaunchMode(args: {
  placement: AgentLaunchModePlacement
  settings: AgentLaunchModeSettings | null | undefined
  terminalOnly?: boolean
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
  if (args.terminalOnly || (surface !== 'chat' && !nativeChatPreferenceFor(settings, agent))) {
    return {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: `Started ${vocabulary.terminal}, the default for new agent tabs in your settings.`
    }
  }
  // Federated launches create terminals; this host cannot establish the remote’s chat support.
  if (placement.on) {
    return blocked('remote_execution_host')
  }
  const cwdRelation = launchCwdRelation(placement)
  const support = resolveStructuredNativeChatSupport({
    agent,
    executionHostId: 'local',
    reusesTerminal: Boolean(placement.terminal),
    hostCapabilities: RUNTIME_CAPABILITIES,
    hostStructuredAgents: REGISTERED_STRUCTURED_AGENTS,
    // Resolved-workspace support still decides runtime constraints such as WSL.
    ...(placement.workspaceKind ? { workspaceKind: placement.workspaceKind } : {}),
    startsOutsideWorkspaceRoot:
      cwdRelation === 'custom' || (surface !== 'chat' && cwdRelation === 'unknown')
  })
  if (!support.supported) {
    return blocked(BLOCKER_REASON[support.blocker])
  }
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

/** Refuse explicit chat only before effects; a created workspace keeps its terminal fallback. */
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

/** Unknown host support must fall back to a terminal. */
async function readStructuredCreateSupport(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  worktreeId: string,
  agent: TuiAgent | undefined
): Promise<HostLaunchSupport | null> {
  if (!agent || !REGISTERED_STRUCTURED_AGENTS.includes(agent)) {
    return { supported: false, reason: 'agent' }
  }
  try {
    // These launches have no chat tab to offer the install, so they keep the agent's own CLI.
    return await runtime.getStructuredAgentSessionCreateSupport(`id:${worktreeId}`, agent, {
      requireInstalledChatProgram: true
    })
  } catch {
    return null
  }
}

export function downgradeAgentLaunchModeForHost(
  receipt: AgentLaunchModeReceipt,
  support: HostLaunchSupport | null,
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

export function warnStructuredLaunchDowngrade(
  agent: string,
  receipt: AgentLaunchModeReceipt
): void {
  if (receipt.mode === 'terminal' && receipt.preferred === 'structured') {
    console.warn(`[agent-launch] ${agent} opened a terminal: ${receipt.reason}`)
  }
}

/** A desktop stamp supplies its resolved preference for the launched agent; other callers read the host’s settings. */
export function readAgentLaunchModeSettings(
  runtime: { requireStore(): { getSettings(): AgentLaunchModeSettings | null } },
  caller?: { agent?: string; nativeChatDefault?: boolean }
): AgentLaunchModeSettings | null {
  if (caller?.nativeChatDefault !== undefined) {
    return caller.agent === undefined
      ? {}
      : { nativeChatProviders: { [caller.agent]: caller.nativeChatDefault } }
  }
  try {
    return runtime.requireStore().getSettings()
  } catch (error) {
    console.warn('[agent-launch] could not resolve chat preference', error)
    return null
  }
}
