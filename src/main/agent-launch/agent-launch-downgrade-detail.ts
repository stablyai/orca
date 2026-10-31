import type { AgentLaunchModeReason } from '../../shared/agent-launch-intent'

export type AgentLaunchDowngradeReason = Exclude<
  AgentLaunchModeReason,
  'user_default' | 'requested'
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
  structured_unsupported_on_host: 'the execution host cannot create one here',
  pinned_claude_account:
    '--account runs Claude on a non-active account, which only a terminal can do',
  chat_runtime_not_installed:
    "its chat runtime isn't installed on this host (install it from a new chat tab in Orca)"
}
