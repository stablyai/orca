import { isDesktopBrowserBridgeMethod } from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { randomUUID } from 'node:crypto'
import { captureRemoteCliBrowserRevocation } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcResponse } from '../../runtime/rpc/core'
import type { LazyRpcMethodGroup } from '../../runtime/rpc/lazy-rpc-method-group'
import { DEFAULT_RPC_DISPATCH_CONFIG } from '../../runtime/rpc/methods/eager-rpc-method-registry'

const isAllowed = (method: { name: string }): boolean => isDesktopBrowserBridgeMethod(method.name)

// Browser methods live in lazy groups; a bridge registry built from eager ones alone would serve none.
const BRIDGE_LAZY_GROUPS: readonly LazyRpcMethodGroup[] =
  DEFAULT_RPC_DISPATCH_CONFIG.lazyGroups.map((group) => ({
    matches: (name) => isDesktopBrowserBridgeMethod(name) && group.matches(name),
    load: async () => (await group.load()).filter(isAllowed)
  }))

/** Restrict the registry to the bridge allowlist even if an upstream caller misroutes a method. */
export function createDesktopBrowserBridgeRpcDispatcher(
  runtime: OrcaRuntimeService
): RpcDispatcher {
  return new RpcDispatcher({
    runtime,
    methods: DEFAULT_RPC_DISPATCH_CONFIG.methods.filter(isAllowed),
    lazyGroups: BRIDGE_LAZY_GROUPS,
    callerScope: { kind: 'runtime-paired', grants: [] }
  })
}

export async function dispatchDesktopBrowserBridgeRpc(
  dispatcher: RpcDispatcher,
  method: string,
  params: Record<string, unknown>
): Promise<RpcResponse> {
  const assertNotRevoked = captureRemoteCliBrowserRevocation()
  await dispatcher.ensureMethodLoaded(method)
  // The bridge can be revoked while the lazy group loads; nothing may reach the renderer after that.
  assertNotRevoked()
  // Why: the SSH host's orca CLI is an agent caller; the cursor and tab badge key off it.
  return dispatcher.dispatch(
    { id: randomUUID(), authToken: '', method, params },
    { caller: { kind: 'local-cli' } }
  )
}
