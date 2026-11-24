// The one decision main makes for host traffic it carries itself (attachment uploads): whether an
// environment id names a shared agent's host, reached through its relay link, or a paired server.
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { SharedBotHosts } from './shared-bot-hosts'

type SharedHostCall = (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>

let hosts: Pick<SharedBotHosts, 'ready' | 'reaches' | 'call'> | null = null

export function setSharedBotHostRouting(next: typeof hosts): void {
  hosts = next
}

/** A call to the shared agent's host `environmentId` names, or null when it names a paired server. */
export async function sharedBotHostCall(environmentId: string): Promise<SharedHostCall | null> {
  const current = hosts
  if (!current) {
    return null
  }
  await current.ready()
  return current.reaches(environmentId)
    ? (method, params) => current.call(environmentId, method, params)
    : null
}
