// A computer's pages name a shared agent's host as an execution host (`runtime:<environment id>`), as
// they name its paired servers. The shell sends those calls over this phone's own link to that host
// instead of through the computer, so they reach it with the phone's key, and still while the computer
// is off.
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcEnvelopeFields } from '../../transport/rpc/rpc-envelope-fields'
import type { PhoneSharedAgent } from './phone-shared-agent-store'
import type { PhoneSharedAgents } from './phone-shared-agents'

const RUNTIME_PREFIX = 'runtime:'

/** The shared agent a call's envelope names on `pairedHostId`'s pages, if this phone has its key. */
function sharedAgentOf(
  agents: Pick<PhoneSharedAgents, 'find'>,
  pairedHostId: string,
  envelope: RpcEnvelopeFields | undefined
): PhoneSharedAgent | undefined {
  const target = envelope?.executionHost
  return typeof target === 'string' && target.startsWith(RUNTIME_PREFIX)
    ? agents.find(pairedHostId, target.slice(RUNTIME_PREFIX.length))
    : undefined
}

const routed = new WeakMap<RpcClient, RpcClient>()

/** `client` with calls to this phone's shared agents taken off it; one view per client, so screens
 *  that compare clients see the same one. */
export function routeSharedAgentCalls(
  client: RpcClient,
  pairedHostId: string,
  agents: Pick<PhoneSharedAgents, 'find' | 'call' | 'subscribe'>
): RpcClient {
  const existing = routed.get(client)
  if (existing) {
    return existing
  }
  // Each member read off `client` when called, as it is: a logical client swaps its own.
  const view: RpcClient = {
    requestRoute: client.requestRoute && ((params) => client.requestRoute!(params)),
    updateTerminalSubscriptionViewport: (terminal, viewport) =>
      client.updateTerminalSubscriptionViewport(terminal, viewport),
    getState: () => client.getState(),
    getReconnectAttempt: () => client.getReconnectAttempt(),
    getLastConnectedAt: () => client.getLastConnectedAt(),
    getLastInboundAt: client.getLastInboundAt && (() => client.getLastInboundAt?.() ?? null),
    getGeneration: client.getGeneration && (() => client.getGeneration?.() ?? 0),
    getActivePath: client.getActivePath && (() => client.getActivePath!()),
    getPendingPath: client.getPendingPath && (() => client.getPendingPath?.() ?? null),
    getRelayHostReachability:
      client.getRelayHostReachability && (() => client.getRelayHostReachability!()),
    onConnectionPathChange:
      client.onConnectionPathChange && ((listener) => client.onConnectionPathChange!(listener)),
    getShellHostStatus: client.getShellHostStatus && (() => client.getShellHostStatus?.()),
    carriesRpcEnvelope: client.carriesRpcEnvelope && (() => client.carriesRpcEnvelope?.() ?? true),
    onStateChange: (listener) => client.onStateChange(listener),
    notifyForeground: (reason) => client.notifyForeground(reason),
    probeLivenessNow: client.probeLivenessNow && (() => client.probeLivenessNow?.()),
    close: () => client.close(),
    sendRequest: (method: string, params?: unknown, options?: SendRequestOptions) => {
      const agent = sharedAgentOf(agents, pairedHostId, options?.envelope)
      return agent
        ? agents.call(agent, method, params)
        : client.sendRequest(method, params, options)
    },
    subscribe: (method, params, onData, options) => {
      const agent = sharedAgentOf(agents, pairedHostId, options?.envelope)
      return agent
        ? agents.subscribe(agent, method, params, onData)
        : client.subscribe(method, params, onData, options)
    }
  }
  routed.set(client, view)
  return view
}
