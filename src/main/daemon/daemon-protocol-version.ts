// Why: daemons survive app updates, so wire behavior must be version-gated.
// v36 launches shells from content-addressed wrapper trees; older owners stay attachable.
export const PROTOCOL_VERSION = 36
export const CONTENT_ADDRESSED_SHELL_WRAPPER_DAEMON_PROTOCOL_VERSION = 36
export const ASYNC_CWD_VALIDATION_DAEMON_PROTOCOL_VERSION = 35
export const CODEX_SHELL_LAUNCH_PREFLIGHT_DAEMON_PROTOCOL_VERSION = 34
export const WSL_POSIX_CWD_DAEMON_PROTOCOL_VERSION = 33
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
  28, 29, 30, 31, 32, 33, 34, 35
] as const

export function supportsPtyStartupIngress(protocolVersion: number): boolean {
  return protocolVersion >= PTY_STARTUP_INGRESS_PROTOCOL_VERSION
}

export function supportsMode2031UnsubscribeFact(protocolVersion: number): boolean {
  return protocolVersion >= MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION
}
