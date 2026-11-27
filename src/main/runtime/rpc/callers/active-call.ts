import { AsyncLocalStorage } from 'node:async_hooks'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import type { RpcCallerIdentity } from './rpc-caller-identity'

type ActiveRpcCall = {
  caller: RpcCallerIdentity | undefined
  agentSessionId: string | undefined
  /** The desktop installation a paired device's socket declared, when it declared one. */
  clientInstanceId?: string
}

// Lets code far below a handler tell an agent's CLI call from a person's relayed input.
const activeCall = new AsyncLocalStorage<ActiveRpcCall>()

export function runWithActiveRpcCaller<T>(
  caller: RpcCallerIdentity | undefined,
  run: () => T,
  claimedAgentSessionId?: string,
  clientInstanceId?: string,
  scope?: { kind: string; botId?: string; accountId?: string }
): T {
  // Only this host's CLI can name a chat here; as in the handoff card, other callers act for a person.
  const agentSessionId =
    caller?.kind === 'local-cli' && claimedAgentSessionId && isOrcaSessionId(claimedAgentSessionId)
      ? claimedAgentSessionId
      : undefined
  return activeCall.run(
    { caller, agentSessionId, ...(clientInstanceId ? { clientInstanceId } : {}) },
    () => runWithActiveTeammate(scope, run)
  )
}

/** The caller of the RPC handler this code runs under; undefined outside any handler. */
export function getActiveRpcCaller(): RpcCallerIdentity | undefined {
  return activeCall.getStore()?.caller
}

export function getActiveRpcClientInstanceId(): string | undefined {
  return activeCall.getStore()?.clientInstanceId
}

/** The chat whose agent sent this call, as its CLI claims it: display attribution, never authority. */
export function getActiveRpcAgentSessionId(): string | undefined {
  return activeCall.getStore()?.agentSessionId
}

// The share a teammate's call is admitted as, for the tab store and host window, which decide by it
// (teammate-rules.ts, rule 4); kept apart from the caller identity so it reaches streams too.
const activeTeammate = new AsyncLocalStorage<{ botId: string; accountId: string } | null>()

export function runWithActiveTeammate<T>(
  scope: { kind: string; botId?: string; accountId?: string } | undefined,
  run: () => T
): T {
  return activeTeammate.run(
    scope?.kind === 'bot-share' && scope.botId !== undefined && scope.accountId !== undefined
      ? { botId: scope.botId, accountId: scope.accountId }
      : null,
    run
  )
}

/** The teammate whose admitted call this code runs under; null for everyone else. */
export function getActiveTeammate(): { botId: string; accountId: string } | null {
  return activeTeammate.getStore() ?? null
}

/** Re-enters this call later, for work a queue runs from inside another caller's call. */
export function captureActiveRpcCall(): <T>(run: () => T) => T {
  const call = activeCall.getStore()
  return (run) => (call ? activeCall.run(call, run) : activeCall.exit(run))
}
