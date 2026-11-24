// A computer's pages name a shared agent's host as an execution host (`runtime:<environment id>`), as
// they name its paired servers. The shell sends those calls over this phone's own link to that host
// instead of through the computer, so they reach it with the phone's key, and still while the computer
// is off.
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcEnvelopeFields } from '../../transport/rpc/rpc-envelope-fields'
import type { PhoneSharedAgent } from './phone-shared-agent-store'
import { phoneSharedAgents, type PhoneSharedAgents } from './phone-shared-agents'

const RUNTIME_PREFIX = 'runtime:'

type Agents = Pick<PhoneSharedAgents, 'ready' | 'loaded' | 'find' | 'call' | 'subscribe'>

function runtimeTarget(envelope: RpcEnvelopeFields | undefined): string | null {
  const target = envelope?.executionHost
  return typeof target === 'string' && target.startsWith(RUNTIME_PREFIX)
    ? target.slice(RUNTIME_PREFIX.length)
    : null
}

/** The shared agent a call's envelope names on `pairedHostId`'s pages, if this phone has its key.
 *  Read only once the phone's shared agents are loaded (`agents.loaded()`). */
function sharedAgentOf(
  agents: Pick<PhoneSharedAgents, 'find'>,
  pairedHostId: string,
  envelope: RpcEnvelopeFields | undefined
): PhoneSharedAgent | undefined {
  const environmentId = runtimeTarget(envelope)
  return environmentId === null ? undefined : agents.find(pairedHostId, environmentId)
}

/**
 * Whether a page frame goes to one of this phone's shared agents rather than the computer: such a
 * frame needs no verdict from the computer, which may be off. A `runtime:` frame read before the
 * phone's shared agents are loaded counts as one; its call waits for them and then goes to the
 * computer if it names none.
 */
export function namesPhoneSharedAgent(
  agents: Pick<PhoneSharedAgents, 'loaded' | 'find'>,
  pairedHostId: string,
  envelope: RpcEnvelopeFields | undefined
): boolean {
  if (runtimeTarget(envelope) === null) {
    return false
  }
  return !agents.loaded() || sharedAgentOf(agents, pairedHostId, envelope) !== undefined
}

// One view per client and computer, so screens that compare clients see the same one.
const routed = new WeakMap<RpcClient, Map<string, RpcClient>>()

/** `client` with calls to this phone's shared agents taken off it. */
export function routeSharedAgentCalls(
  client: RpcClient,
  pairedHostId: string,
  agents: Agents
): RpcClient {
  const views = routed.get(client) ?? new Map<string, RpcClient>()
  routed.set(client, views)
  const existing = views.get(pairedHostId)
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
    sendRequest: async (method: string, params?: unknown, options?: SendRequestOptions) => {
      if (runtimeTarget(options?.envelope) !== null) {
        await agents.ready()
      }
      const agent = sharedAgentOf(agents, pairedHostId, options?.envelope)
      return agent
        ? await agents.call(agent, method, params)
        : await client.sendRequest(method, params, options)
    },
    subscribe: (method, params, onData, options) => {
      const open = () => {
        const agent = sharedAgentOf(agents, pairedHostId, options?.envelope)
        return agent
          ? agents.subscribe(agent, method, params, onData)
          : client.subscribe(method, params, onData, options)
      }
      if (agents.loaded() || runtimeTarget(options?.envelope) === null) {
        return open()
      }
      // Opened once the phone's shared agents are loaded, unless released first.
      let stop: (() => void) | null = null
      let released = false
      void agents.ready().then(() => {
        if (!released) {
          stop = open()
        }
      })
      return () => {
        released = true
        stop?.()
      }
    }
  }
  views.set(pairedHostId, view)
  return view
}

/** What a computer's page bridge takes for the phone's shared agents: its client with their calls
 *  taken off it, and which frames those are, which the computer's verdict doesn't hold. */
export function sharedAgentBridgeRoutes(client: RpcClient, pairedHostId: string) {
  const agents = phoneSharedAgents()
  // Loaded before the page's first frame where it can be: a shared agent's call waits for it.
  void agents.ready()
  return {
    client: routeSharedAgentCalls(client, pairedHostId, agents),
    bypassesVerdict: (message: { envelope?: RpcEnvelopeFields }) =>
      namesPhoneSharedAgent(agents, pairedHostId, message.envelope)
  }
}
