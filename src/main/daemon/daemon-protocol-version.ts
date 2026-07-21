// Why: daemons survive app updates, so wire behavior must be version-gated.
export const PROTOCOL_VERSION = 25
export const PTY_STARTUP_INGRESS_PROTOCOL_VERSION = 25
export const GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION = 22
export const CLEAN_DISCONNECT_PROTOCOL_VERSION = 24
export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24
] as const

export function supportsPtyStartupIngress(protocolVersion: number): boolean {
  return protocolVersion >= PTY_STARTUP_INGRESS_PROTOCOL_VERSION
}
