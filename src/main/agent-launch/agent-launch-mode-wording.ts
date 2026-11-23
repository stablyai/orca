import type {
  AgentLaunchModeReason,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch/contracts/agent-launch-intent'

/** Who preferred a chat: the caller, the user's default, or the worker lineage it starts under. */
export type ChatPreference = 'requested' | 'default' | 'lineage'

export const LINEAGE_CHATS =
  "Workers started from a persistent agent's home, and their workers, run as structured chat sessions"

/** Agents whose chats can't run Orca commands as themselves, so a chat worker could never report. */
export const CHATS_WITHOUT_ORCA_IDENTITY: readonly string[] = ['hermes']

export function chatPreferenceOf(receipt: AgentLaunchModeReceipt): ChatPreference {
  return receipt.reason === 'requested'
    ? 'requested'
    : receipt.reason === 'chat_lineage'
      ? 'lineage'
      : 'default'
}

export function preferenceLead(preference: ChatPreference): string {
  return preference === 'lineage'
    ? LINEAGE_CHATS
    : `${preference === 'requested' ? 'You asked for' : 'Your default is'} a structured chat session`
}

/** Caller-specific receipt wording, shared across desktop, mobile and orchestration. */
export type AgentLaunchModeVocabulary = {
  structured: string
  terminal: string
  /** Override wording such as orchestration’s --terminal guidance for the calling surface. */
  detailOverrides?: Partial<Record<AgentLaunchDowngradeReason, string>>
}

export type AgentLaunchDowngradeReason = Exclude<
  AgentLaunchModeReason,
  'user_default' | 'requested' | 'chat_lineage'
>

export const DOWNGRADE_DETAIL: Record<AgentLaunchDowngradeReason, string> = {
  remote_execution_host: 'this launch runs on a remote execution host',
  reused_terminal: 'it reuses a running terminal agent',
  agent_without_structured_session: 'this agent has no structured session',
  tui_launch_command: 'it asks to start in a folder other than its workspace',
  structured_sessions_unavailable: 'this runtime does not support structured agent sessions',
  structured_support_unknown: 'the execution host has not established structured session support',
  wsl_execution_runtime: 'this workspace runs under WSL',
  codex_on_windows: 'Codex has no structured session on Windows',
  chat_unavailable_on_windows:
    "on Windows this agent's chat runs on agy, which is missing, outdated, or not signed in with a personal Google account",
  structured_unsupported_on_host: 'the execution host cannot create one here',
  pinned_claude_account:
    '--account runs Claude on a non-active account, which only a terminal can do',
  chat_runtime_not_installed:
    "its chat runtime isn't installed on this host (install it from a new chat tab in Orca)",
  chat_cannot_run_orca_commands:
    "this agent's chats can't run Orca commands as themselves yet, so a chat worker couldn't report"
}

export function downgraded(
  reason: AgentLaunchDowngradeReason,
  vocabulary: AgentLaunchModeVocabulary,
  preference: ChatPreference = 'default',
  detail?: string
): AgentLaunchModeReceipt {
  const why = detail ?? vocabulary.detailOverrides?.[reason] ?? DOWNGRADE_DETAIL[reason]
  return {
    mode: 'terminal',
    preferred: 'structured',
    reason,
    detail: `${preferenceLead(preference)}, but ${why}; started ${vocabulary.terminal} instead.`
  }
}
