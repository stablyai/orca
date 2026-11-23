/** Chat defaults may fall back; explicit chat is refused only conclusively before launch effects. */

import { requestsCwdOutsideWorkspaceRoot } from '../../shared/shell/launch/terminal-startup-cwd'
import type { AgentLaunchModeReceipt } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { RUNTIME_CAPABILITIES } from '../../shared/remote-runtime/protocol/protocol-version'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'
import {
  nativeChatPreferenceFor,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../shared/agent-launch/choices/structured-native-chat-launch-route'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type {
  StructuredAgentCreateSupportReason,
  StructuredAgentCreateSupportReply
} from '../../shared/agent-session/lifecycle/operations/structured-agent-create-support-reply'
import type { WorkspaceLaunchKind } from '../../shared/agent-launch/contracts/workspace-launch-kind'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentLaunchSurface } from '../../shared/agent-launch/contracts/agent-launch-surface'
import { formatAgentTypeLabel } from '../../shared/agent-status/presentation/agent-type-label'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'
import {
  CHATS_WITHOUT_ORCA_IDENTITY,
  DOWNGRADE_DETAIL,
  LINEAGE_CHATS,
  chatPreferenceOf,
  downgraded,
  preferenceLead,
  type AgentLaunchDowngradeReason,
  type AgentLaunchModeVocabulary,
  type ChatPreference
} from './agent-launch-mode-wording'
import {
  withWslHostChatRecovery,
  type WslHostChatSettingsSource
} from './agent-launch-wsl-host-recovery'

export type { AgentLaunchModeVocabulary }

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

const HOST_SUPPORT_REASON: Record<StructuredAgentCreateSupportReason, AgentLaunchDowngradeReason> =
  {
    agent: 'structured_unsupported_on_host',
    remote: 'remote_execution_host',
    wsl: 'wsl_execution_runtime',
    windows: 'chat_unavailable_on_windows',
    'chat-program': 'chat_runtime_not_installed'
  }

/** Apply shared feasibility policy to facts available before resolving the workspace. */
export function decideAgentLaunchMode(args: {
  placement: AgentLaunchModePlacement
  settings: AgentLaunchModeSettings | null | undefined
  terminalOnly?: boolean
  surface?: AgentLaunchSurface
  /** Prefer a chat whatever the settings say, falling back (never refusing) where none can run. */
  chatLineage?: boolean
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
  const preference: ChatPreference =
    surface === 'chat' ? 'requested' : args.chatLineage ? 'lineage' : 'default'
  const blocked = (reason: AgentLaunchDowngradeReason): AgentLaunchModeReceipt =>
    unavailableLaunchMode(reason, vocabulary, preference, {
      agent,
      phase: 'before-effects'
    })
  if (
    args.terminalOnly ||
    (preference === 'default' && !nativeChatPreferenceFor(settings, agent))
  ) {
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
  if (preference === 'lineage' && CHATS_WITHOUT_ORCA_IDENTITY.includes(agent)) {
    return blocked('chat_cannot_run_orca_commands')
  }
  if (preference === 'lineage') {
    return {
      mode: 'structured',
      preferred: 'structured',
      reason: 'chat_lineage',
      detail: `Started ${vocabulary.structured}. ${LINEAGE_CHATS}.`
    }
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
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'> &
    WslHostChatSettingsSource,
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
      chatPreferenceOf(receipt),
      {
        ...context,
        agent
      },
      launchCwdRelation(context) === 'custom'
    )
  }
  const support = await readStructuredCreateSupport(runtime, worktreeId, agent)
  const settlement = context ? { ...context, agent } : undefined
  try {
    return downgradeAgentLaunchModeForHost(receipt, support, vocabulary, settlement)
  } catch (error) {
    throw await withWslHostChatRecovery(error, context?.workspacePath, runtime)
  }
}

/** Unknown host support must fall back to a terminal. */
async function readStructuredCreateSupport(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  worktreeId: string,
  agent: TuiAgent | undefined
): Promise<StructuredAgentCreateSupportReply | null> {
  if (!agent || !REGISTERED_STRUCTURED_AGENTS.includes(agent)) {
    return { supported: false, reason: 'agent' }
  }
  try {
    // These launches have no chat tab to offer the install, so they keep the agent's own CLI.
    const selector =
      worktreeId.startsWith('identity:') || worktreeId.startsWith('id:')
        ? worktreeId
        : `id:${worktreeId}`
    return await runtime.getStructuredAgentSessionCreateSupport(selector, agent, {
      requireInstalledChatProgram: true
    })
  } catch {
    return null
  }
}

export function downgradeAgentLaunchModeForHost(
  receipt: AgentLaunchModeReceipt,
  support: StructuredAgentCreateSupportReply | null,
  vocabulary: AgentLaunchModeVocabulary = DEFAULT_LAUNCH_VOCABULARY,
  context?: AgentLaunchModeSettlement
): AgentLaunchModeReceipt {
  if (receipt.mode !== 'structured' || support?.supported) {
    return receipt
  }
  const preference = chatPreferenceOf(receipt)
  if (support === null) {
    return downgraded(BLOCKER_REASON['runtime-capability-unknown'], vocabulary, preference)
  }
  return unavailableLaunchMode(
    support.reason ? HOST_SUPPORT_REASON[support.reason] : 'structured_unsupported_on_host',
    vocabulary,
    preference,
    context
  )
}

export function downgradeAgentLaunchModeForStructuredRefusal(
  receipt: AgentLaunchModeReceipt,
  vocabulary: AgentLaunchModeVocabulary,
  context?: AgentLaunchModeSettlement
): AgentLaunchModeReceipt {
  const preference = chatPreferenceOf(receipt)
  const fallback = unavailableLaunchMode(
    'structured_unsupported_on_host',
    vocabulary,
    preference,
    context
  )
  return {
    ...fallback,
    detail: `${preferenceLead(preference)}, but the host refused to create one here; started ${vocabulary.terminal} instead.`
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
  preference: ChatPreference,
  context?: AgentLaunchModeSettlement,
  conclusive = true
): AgentLaunchModeReceipt {
  if (preference === 'requested' && conclusive && context?.phase === 'before-effects') {
    throw new AgentLaunchSurfaceUnavailableError(
      `${formatAgentTypeLabel(context.agent)} can't open as a chat here because ${DOWNGRADE_DETAIL[reason]}. Start it in a terminal instead.`,
      reason
    )
  }
  return downgraded(reason, vocabulary, preference)
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
