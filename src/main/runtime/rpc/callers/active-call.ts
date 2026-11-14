import { AsyncLocalStorage } from 'node:async_hooks'
import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { RpcCallerIdentity } from './rpc-caller-identity'

type ActiveRpcCall = {
  caller: RpcCallerIdentity | undefined
  agentSessionId: string | undefined
}

// Lets code far below a handler tell an agent's CLI call from a person's relayed input.
const activeCall = new AsyncLocalStorage<ActiveRpcCall>()

export function runWithActiveRpcCaller<T>(
  caller: RpcCallerIdentity | undefined,
  run: () => T,
  claimedAgentSessionId?: string
): T {
  // Only this host's CLI can name a chat here; as in the handoff card, other callers act for a person.
  const agentSessionId =
    caller?.kind === 'local-cli' && claimedAgentSessionId && isOrcaSessionId(claimedAgentSessionId)
      ? claimedAgentSessionId
      : undefined
  return activeCall.run({ caller, agentSessionId }, run)
}

/** The caller of the RPC handler this code runs under; undefined outside any handler. */
export function getActiveRpcCaller(): RpcCallerIdentity | undefined {
  return activeCall.getStore()?.caller
}

/** The chat whose agent sent this call, as its CLI claims it: display attribution, never authority. */
export function getActiveRpcAgentSessionId(): string | undefined {
  return activeCall.getStore()?.agentSessionId
}

/** Re-enters this call later, for work a queue runs from inside another caller's call. */
export function captureActiveRpcCall(): <T>(run: () => T) => T {
  const call = activeCall.getStore()
  return (run) => (call ? activeCall.run(call, run) : activeCall.exit(run))
}
