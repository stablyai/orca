// A shared agent's host is reached as a paired server (shared-host-keys.ts). Two things stay with the
// desktop's shared-agents owner: a call its share answers here before the paired path sends it, and
// this computer's phones' keys to those hosts (bots-share-phone.ts).
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../../shared/remote-runtime/rpc/rpc-response-shape'
import type { SharedBotHosts } from '../../../bots/shared-with-me/shared-bot-hosts'

type SharedHosts = Pick<SharedBotHosts, 'ready' | 'settled' | 'phones' | 'answerHere'>

let sharedHosts: SharedHosts | null = null

/** Set once by the desktop's shared-agents owner; `orca serve` and the phone path have none. */
export function setSharedHostsOwner(hosts: SharedHosts | null): void {
  sharedHosts = hosts
}

/** The share's own answer to a call (SharedBotHosts.answerHere), or null to send it on. */
export async function answerSharedHostHere(
  selector: string,
  method: string,
  params: unknown,
  send: (method: string, params: unknown) => Promise<RpcResponse>
): Promise<RuntimeRpcResponse<unknown> | null> {
  return sharedHosts ? sharedHosts.answerHere(selector, method, params, send) : null
}

/** This computer's phones' keys to the shared hosts, once the kept shares are loaded; null where no
 *  window lists shared agents. */
export async function sharedHostPhoneGrants(): Promise<SharedBotHosts['phones'] | null> {
  const hosts = sharedHosts
  await hosts?.ready()
  // A phone whose link dropped asks the list to learn whether it was a revoke: the read says.
  await hosts?.settled()
  return hosts?.phones ?? null
}
