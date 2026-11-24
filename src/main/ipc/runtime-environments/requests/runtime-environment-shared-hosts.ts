// Hosts named by an environment id that has no pairing here: an agent shared with this Orca account,
// reached over its share link. Every runtimeEnvironments call and stream asks this before the
// paired-server registry, so a shared host has one route, the same as a paired server's.
import {
  BOT_SHARE_RPC_METHODS,
  BOT_SHARE_STREAM_METHODS
} from '../../../../shared/bots/bot-share-rpc-methods'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { SharedBotHosts } from '../../../bots/shared-with-me/shared-bot-hosts'

type SharedHosts = Pick<SharedBotHosts, 'ready' | 'reaches' | 'call' | 'subscribe'>
type OnResponse = (response: RuntimeRpcResponse<unknown>) => void

export type SharedHostRoute = {
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
  /** A stream, or an abortable call sent as one: answered once, as a call. */
  subscribe: (method: string, params: unknown, onResponse: OnResponse) => Promise<() => void>
}

let sharedHosts: SharedHosts | null = null

/** Set once by the desktop's shared-agents owner; `orca serve` and the phone path have none. */
export function routeSharedHostsThrough(hosts: SharedHosts | null): void {
  sharedHosts = hosts
}

/** The share link `selector` names, or null for a paired server. */
export async function sharedHostRoute(selector: string): Promise<SharedHostRoute | null> {
  const hosts = sharedHosts
  if (!hosts) {
    return null
  }
  await hosts.ready()
  if (!hosts.reaches(selector)) {
    return null
  }
  const call = async (method: string, params: unknown) =>
    refusal(method) ?? (await hosts.call(selector, method, params))
  return {
    call,
    subscribe: async (method, params, onResponse) => {
      if (refusal(method) || !BOT_SHARE_STREAM_METHODS.has(method)) {
        onResponse(await call(method, params))
        return () => {}
      }
      return hosts.subscribe(selector, method, params, onResponse)
    }
  }
}

/** The id a selector names: a shared host's is its own; a paired server's resolves through `resolve`. */
export async function runtimeEnvironmentIdOf(
  selector: string,
  resolve: (selector: string) => Promise<{ id: string }>
): Promise<string> {
  return (await sharedHostRoute(selector)) ? selector : (await resolve(selector)).id
}

/**
 * The one gate on what a teammate's Orca asks a shared host: a method off the share allowlist (the
 * owner's activity, suggestions, paired-server asks, status) is the host's to refuse, so it is
 * refused here with the host's own answer and never sent.
 */
function refusal(method: string): RuntimeRpcFailure | null {
  return BOT_SHARE_RPC_METHODS.has(method)
    ? null
    : {
        id: method,
        ok: false,
        // Read by its code, as from a host that lacks the method; never shown.
        error: { code: 'method_not_found', message: method }
      }
}
