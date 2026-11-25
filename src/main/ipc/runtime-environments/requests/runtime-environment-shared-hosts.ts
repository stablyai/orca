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
import type {
  RuntimeHostStatusResponse,
  RuntimeHostStatusSnapshot
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeHostStatusOwner } from '../../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import { SharedHostStatuses } from './runtime-environment-shared-host-status'

type SharedHosts = Pick<SharedBotHosts, 'ready' | 'reaches' | 'call' | 'subscribe' | 'views'>
type OnResponse = (response: RuntimeRpcResponse<unknown>) => void
type StatusOptions = Parameters<RuntimeHostStatusOwner['refresh']>[0]

export type SharedHostRoute = {
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
  /** A stream, or an abortable call sent as one: answered once, as a call. */
  subscribe: (method: string, params: unknown, onResponse: OnResponse) => Promise<() => void>
  /** What getStatus and connect answer, from the same owner as the host's `status.get` calls. */
  status: (options?: StatusOptions) => Promise<RuntimeHostStatusResponse>
}

let sharedHosts: { hosts: SharedHosts; statuses: SharedHostStatuses } | null = null

/** Set once by the desktop's shared-agents owner; `orca serve` and the phone path have none. */
export function routeSharedHostsThrough(hosts: SharedHosts | null): void {
  sharedHosts?.statuses.dispose()
  sharedHosts = hosts ? { hosts, statuses: new SharedHostStatuses(hosts) } : null
}

/** Each shared host's status, listed with the paired servers' by getStatusSnapshots. */
export function sharedHostStatusSnapshots(): RuntimeHostStatusSnapshot[] {
  return sharedHosts?.statuses.snapshots() ?? []
}

/** The shared hosts' list or links changed: their statuses follow. */
export function sharedHostsChanged(): void {
  sharedHosts?.statuses.changed()
}

/** The share link `selector` names, or null for a paired server. */
export async function sharedHostRoute(selector: string): Promise<SharedHostRoute | null> {
  const route = sharedHosts
  if (!route) {
    return null
  }
  const { hosts, statuses } = route
  await hosts.ready()
  if (!hosts.reaches(selector)) {
    return null
  }
  const status = (options?: StatusOptions) => statuses.owner(selector).refresh(options)
  const call = async (method: string, params: unknown) =>
    refusal(method) ??
    (method === 'status.get' ? await status() : await hosts.call(selector, method, params))
  return {
    status,
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
 * owner's activity, suggestions, paired-server asks) is the host's to refuse, so it is refused here
 * with the host's own answer and never sent.
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
