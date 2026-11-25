// Hosts named by an environment id that has no pairing here: an agent shared with this Orca account,
// reached over its share link. Every runtimeEnvironments call and stream asks this before the
// paired-server registry, so a shared host has one route, the same as a paired server's. This
// computer's phones reach their own keys to those hosts here too (bots-share-phone.ts).
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

type SharedHosts = Pick<
  SharedBotHosts,
  'ready' | 'reaches' | 'call' | 'subscribe' | 'views' | 'store' | 'phones'
>
type OnResponse = (response: RuntimeRpcResponse<unknown>) => void
type StatusOptions = Parameters<RuntimeHostStatusOwner['refresh']>[0]

export type SharedHostRoute = {
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
  /** A stream, or an abortable call sent as one: answered once, as a call. */
  subscribe: (method: string, params: unknown, onResponse: OnResponse) => Promise<() => void>
  /** What getStatus and connect answer, from the same owner as the host's `status.get` calls. */
  status: (options?: StatusOptions) => Promise<RuntimeHostStatusResponse>
}

/** What a share allows, read off the method registry by whoever wires the shared hosts (importing the
 *  registry here would cycle through the methods that call runtimeEnvironments). */
export type SharedHostMethods = {
  allows: (method: string) => boolean
  streams: (method: string) => boolean
}

let sharedHosts: {
  hosts: SharedHosts
  methods: SharedHostMethods
  statuses: SharedHostStatuses
} | null = null

/** Set once by the desktop's shared-agents owner; `orca serve` and the phone path have none. */
export function routeSharedHostsThrough(
  route: { hosts: SharedHosts; methods: SharedHostMethods } | null
): void {
  sharedHosts?.statuses.dispose()
  sharedHosts = route ? { ...route, statuses: new SharedHostStatuses(route.hosts) } : null
}

/** Each shared host's status, listed with the paired servers' by getStatusSnapshots. */
export function sharedHostStatusSnapshots(): RuntimeHostStatusSnapshot[] {
  return sharedHosts?.statuses.snapshots() ?? []
}

/** The shared hosts' list or links changed: their statuses follow. */
export function sharedHostsChanged(): void {
  sharedHosts?.statuses.changed()
}

/** The host a runtimeEnvironments selector names: resolved here once, and every caller handles
 *  both kinds. */
export type RuntimeEnvironmentHost =
  | { kind: 'shared'; route: SharedHostRoute }
  | { kind: 'paired'; selector: string }

export async function resolveRuntimeEnvironmentHost(
  selector: string
): Promise<RuntimeEnvironmentHost> {
  const route = await sharedHostRoute(selector)
  return route ? { kind: 'shared', route } : { kind: 'paired', selector }
}

async function sharedHostRoute(selector: string): Promise<SharedHostRoute | null> {
  const route = sharedHosts
  if (!route) {
    return null
  }
  const { hosts, methods, statuses } = route
  // The one gate on what a teammate's Orca asks a shared host: a method off the share allowlist is
  // the host's to refuse, so it is refused here with the host's own answer and never sent.
  const refusal = (method: string) => (methods.allows(method) ? null : methodNotFound(method))
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
      if (refusal(method) || !methods.streams(method)) {
        onResponse(await call(method, params))
        return () => {}
      }
      return hosts.subscribe(selector, method, params, onResponse)
    }
  }
}

/** This computer's phones' keys to the shared hosts, once the kept shares are loaded; null where no
 *  window lists shared agents. */
export async function sharedHostPhoneGrants(): Promise<SharedBotHosts['phones'] | null> {
  const hosts = sharedHosts?.hosts
  await hosts?.ready()
  return hosts?.phones ?? null
}

/** The id a selector names: a shared host's is its own; a paired server's resolves through `resolve`. */
export async function runtimeEnvironmentIdOf(
  selector: string,
  resolve: (selector: string) => Promise<{ id: string }>
): Promise<string> {
  const host = await resolveRuntimeEnvironmentHost(selector)
  switch (host.kind) {
    case 'shared':
      return selector
    case 'paired':
      return (await resolve(selector)).id
  }
}

function methodNotFound(method: string): RuntimeRpcFailure {
  return {
    id: method,
    ok: false,
    // Read by its code, as from a host that lacks the method; never shown.
    error: { code: 'method_not_found', message: method }
  }
}
