// Why: daemons survive app updates, so wire behavior must be version-gated.
// v54 reads the macOS process table in process instead of forking setuid ps on every poll (#31783).
// v53 rolls the daemon-side terminal fixes since v1.4.241 (foreground confirmation for chat continuation, ConPTY reflow, WSL malloc tunables) into a fresh daemon.
// v52 rolls the daemon-side terminal fixes since v1.4.240 (ConPTY, teardown, spawn pane keys) into a fresh daemon.
// v51 checks terminal identity, ownership and attachments before reserving teardown.
// v50 makes the `codex` function keep Orca's terminal identity under a filtering shell_environment_policy.
// v49 makes the `claude` function follow the selection over the user's own CLAUDE_CONFIG_DIR.
// v48 skips v47, which the 1.4.227 release (1.4.224 plus picks) took; its daemon is adopted as previous.
// v46 starts each new Linux terminal in its own systemd scope beside the daemon's.
// v45 starts new macOS tabs in the update-safe terminal host helper beside an existing daemon.
// v44 gives every pane the `claude` function that follows the selected Claude account (v42 had it,
// v43 dropped it with the revert); v41 stages long startup commands as sourced scripts; v40 rolled
// the #25130/#24636 shell-wrapper changes and the wider agent list into a fresh daemon; older owners
// stay attachable.
export const PROTOCOL_VERSION = 54
export const FENCED_TERMINATION_PROTOCOL_VERSION = 51
export const CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION = 42
export const CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION = 43
// v39 gives plain fish panes Orca's codex function through XDG_DATA_DIRS.
export const CODEX_FISH_SHELL_FUNCTION_DAEMON_PROTOCOL_VERSION = 39
// Why: older daemons reject `setColorQueryReplyColors` as an unknown request type.
export const COLOR_QUERY_REPLY_COLORS_DAEMON_PROTOCOL_VERSION = 38
export const CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION = 37
export const ASYNC_CWD_VALIDATION_DAEMON_PROTOCOL_VERSION = 35
export const SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION = 32
export const STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION = 31
export const HISTORY_SEED_TRANSFER_PROTOCOL_VERSION = 30
export const COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION = 27
export const GET_FOREGROUND_PROCESS_PROTOCOL_VERSION = 11
// Why: `getSize` landed in v18; older daemons reject it as an unknown request type.
export const GET_SIZE_PROTOCOL_VERSION = 18
export const PTY_STARTUP_INGRESS_PROTOCOL_VERSION = 25
export const AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION = 26
export const AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION = 26
export const GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION = 22
export const CLEAN_DISCONNECT_PROTOCOL_VERSION = 24
// Why (#9993): a gate-managed pane's bytes never reach the renderer, so main's
// transient facts are the only thing that can retire a 2031 subscription for it.
// Daemons before this version emit '2031-subscribe' but have no unsubscribe fact
// at all, so a TUI exiting while hidden would leave the subscription registered
// forever and the next theme flip would inject CSI 997 into whatever replaced it.
// Scan authority moves to the daemon only while a session is backgrounded, so the
// gate lives on backgrounding itself (setPtyBackgrounded): a pre-v29 daemon is
// never asked to thin, and main's scanner — which emits BOTH facts — stays
// authoritative over the whole stream. Filtering the subscribe fact alone would
// not help, because the visible-era subscription is registered by main.
export const MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION = 29
export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
  52, 53
] as const

export function supportsColorQueryReplyColors(protocolVersion: number): boolean {
  return protocolVersion >= COLOR_QUERY_REPLY_COLORS_DAEMON_PROTOCOL_VERSION
}

export function supportsPtyStartupIngress(protocolVersion: number): boolean {
  return protocolVersion >= PTY_STARTUP_INGRESS_PROTOCOL_VERSION
}

export function supportsMode2031UnsubscribeFact(protocolVersion: number): boolean {
  return protocolVersion >= MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION
}
