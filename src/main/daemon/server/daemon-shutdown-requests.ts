import type { DaemonRequestRouterOptions } from './daemon-request-router'

type ShutdownOptions = Pick<
  DaemonRequestRouterOptions,
  'connections' | 'admission' | 'host' | 'relays' | 'lifecycle' | 'log'
>

/** A daemon still owning any terminal or chat agent never retires on request. */
export function answerShutdownIfIdle(
  options: ShutdownOptions,
  clientId: string,
  requestId: string
): { retiring: boolean } {
  const client = options.connections.get(clientId)
  const retiring =
    client !== undefined &&
    client.streamSocket !== null &&
    options.connections.size === 1 &&
    options.admission.inFlight === 0 &&
    options.host.listSessions().length === 0 &&
    options.relays.liveCount === 0 &&
    options.connections.hasOnlyTransportsFor(client)
  if (retiring) {
    options.lifecycle.retireAfterIdleReply(clientId, requestId, client.controlSocket)
  }
  return { retiring }
}

export async function answerShutdown(
  options: ShutdownOptions,
  clientId: string,
  requestId: string,
  killSessions: boolean
): Promise<Record<string, never>> {
  options.log.log('shutdown', {
    reason: 'rpc',
    killSessions: killSessions === true
  })
  const serverClose = options.lifecycle.beginOrdinaryShutdownFence()
  if (killSessions) {
    // Both finish before shutdown goes on, even when one of them fails.
    const disposed = await Promise.allSettled([options.host.dispose(), options.relays.dispose()])
    const failure = disposed.find((result) => result.status === 'rejected')
    if (failure) {
      const error: unknown = failure.reason
      options.log.log('shutdown-dispose-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const controlSocket = options.connections.get(clientId)?.controlSocket
  if (controlSocket) {
    options.lifecycle.deferRpcShutdownUntilReply(clientId, requestId, controlSocket, serverClose)
  } else {
    options.lifecycle.finishRpcShutdownWithoutReply(serverClose)
  }
  return {}
}
