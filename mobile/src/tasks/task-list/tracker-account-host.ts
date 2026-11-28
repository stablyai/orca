import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { settingsRead } from '../../settings/mobile-settings-read-operations'
import { settingsField } from '../../settings/mobile-settings-projection'
import {
  rpcClientForExecutionHost,
  scopeRpcClientToExecutionHost
} from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'

/** The client tracker account setup (Linear, Jira) uses, bound to the desktop's tracker host as setup starts so a later
 *  change of that default cannot send the key elsewhere. Older desktops (no host) route it themselves. */
export async function bindTrackerAccountClient(
  client: RpcClient,
  hostCapabilities: readonly string[]
): Promise<RpcClient> {
  const settings = await settingsRead
    .request(client)
    .then((reply) => settingsRead.interpret(reply))
    .catch(() => null)
  const raw = settings?.accepted ? settingsField(settings.value, 'trackerAccountHost') : undefined
  const host = normalizeExecutionHostId(typeof raw === 'string' ? raw : null)
  if (!host) {
    return client
  }
  // Tag this computer too: an untagged call would follow the desktop's current default.
  if (host === LOCAL_EXECUTION_HOST_ID) {
    return scopeRpcClientToExecutionHost(client, host)
  }
  return rpcClientForExecutionHost(client, hostCapabilities, host) ?? client
}

export type TrackerAccountBinding = { base: RpcClient; client: Promise<RpcClient> }

/** The bound client while it belongs to the current connection; otherwise the plain one. */
export function trackerAccountClient(
  binding: TrackerAccountBinding | null,
  client: RpcClient
): Promise<RpcClient> {
  return binding?.base === client ? binding.client : Promise.resolve(client)
}
