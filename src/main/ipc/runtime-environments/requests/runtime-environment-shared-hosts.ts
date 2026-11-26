// A shared agent's host is reached as a paired server (shared-host-keys.ts). Two things stay with the
// desktop's shared-agents owner: a call its share answers here before the paired path sends it, and
// this computer's phones' keys to those hosts (bots-share-phone.ts).
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../../shared/remote-runtime/rpc/rpc-response-shape'
import type { SharedBotHosts } from '../../../bots/shared-with-me/shared-bot-hosts'

type SharedHosts = Pick<
  SharedBotHosts,
  'ready' | 'settled' | 'phones' | 'answerHere' | 'endedAnswer'
>

let sharedHosts: SharedHosts | null = null

/** Set once by the desktop's shared-agents owner; `orca serve` and the phone path have none. */
export function setSharedHostsOwner(hosts: SharedHosts | null): void {
  sharedHosts = hosts
}

/**
 * Every call to a host, from the window or from main, asks here first: the share answers a call to
 * an ended share, or (held sends on) one its host can't take now. Anything else goes out by `send`.
 */
export async function answerSharedHostFirst(
  selector: string,
  method: string,
  params: unknown,
  send: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
): Promise<RuntimeRpcResponse<unknown>> {
  const sendOn = async (sent: string, sentParams: unknown): Promise<RpcResponse> => {
    const response = await send(sent, sentParams)
    return response.ok ? response : { id: response.id, ok: false, error: response.error }
  }
  const answered = sharedHosts
    ? await sharedHosts.answerHere(selector, method, params, sendOn)
    : null
  return answered ?? send(method, params)
}

/** A call to a share the owner ended, answered as one; null for every other host. */
export async function sharedHostEndedAnswer(
  selector: string,
  method: string
): Promise<RuntimeRpcResponse<unknown> | null> {
  return sharedHosts ? sharedHosts.endedAnswer(selector, method) : null
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
