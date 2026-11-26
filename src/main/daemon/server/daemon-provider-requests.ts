import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { sharedPromiseSettlementWaiters } from '../../../shared/concurrency/promise-settlement-waiters'
import { enumerateDirectoryOnce } from '../permissions/directory-enumeration-probe'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import { spawnHostedProvider } from './daemon-provider-spawn'

/** Undefined leaves every other request to the router. */
export function answerProviderRequest(
  request: DaemonRequest,
  client: ConnectedDaemonClient | undefined,
  socket: Socket,
  options: { providerSpawn: boolean; acceptsProviderWork: () => boolean }
): Promise<unknown> | undefined {
  if (request.type !== 'probeProviderCwd' && request.type !== 'spawnProvider') {
    return undefined
  }
  if (
    !client?.authenticatedPairEstablished ||
    client.controlSocket !== socket ||
    !options.providerSpawn
  ) {
    return Promise.reject(new Error('Provider host unavailable'))
  }
  if (request.type === 'probeProviderCwd') {
    const cwd = request.payload?.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
      return Promise.reject(new Error('Invalid provider working folder'))
    }
    return sharedPromiseSettlementWaiters(enumerateDirectoryOnce(cwd))
      .wait({ timeoutMs: 1_000 })
      .catch(() => null)
      .then((outcome) => ({ outcome }))
  }
  return spawnHostedProvider(request.payload, options.acceptsProviderWork())
}
