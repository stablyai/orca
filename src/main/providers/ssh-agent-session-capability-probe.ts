import { JsonRpcErrorCode } from '../ssh/relay-protocol'

export const SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS = 5_000

export function isSshCapabilityMethodUnavailable(error: unknown): boolean {
  return (error as { code?: unknown })?.code === JsonRpcErrorCode.MethodNotFound
}
