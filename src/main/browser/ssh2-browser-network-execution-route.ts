import type { Client } from 'ssh2'
import {
  SshConnectionWorkAdmissionClosedError,
  SshConnectionWorkLedger
} from '../ssh/ssh-connection-work-ledger'
import { trackSshConnectionChannelLifetime } from '../ssh/ssh-connection-channel-lifetime'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route'
import type { RouteBase } from './ssh-browser-network-execution-route'

export function createSsh2ExecutionRoute(
  base: RouteBase,
  client: Client
): BrowserNetworkExecutionRoute {
  const sockets = new Set<BrowserNetworkDeferredSocket>()
  const lifetime = new SshConnectionWorkLedger()
  let closed = false
  let closing: Promise<void> | undefined
  const isValid = (): boolean =>
    !closed &&
    !base.invalidation.signal.aborted &&
    base.connection.getClient() === client &&
    base.connection.getState().status === 'connected' &&
    base.dependencies.connectionManager.getConnection(base.authority.targetId) ===
      base.connection &&
    base.dependencies.isCurrentAuthority(base.authority)
  const close = (): Promise<void> => {
    if (closing) {
      return closing
    }
    const completion = Promise.withResolvers<void>()
    closing = completion.promise
    closed = true
    const fence = lifetime.fenceForReset()
    void (async () => {
      base.invalidation.abort()
      for (const socket of sockets) {
        socket.destroy()
      }
      await fence.drain(new AbortController().signal)
      base.releaseInvalidation()
    })().then(completion.resolve, completion.reject)
    return closing
  }
  return {
    key: base.key,
    isValid,
    whenInvalidated: base.invalidation.signal.aborted
      ? Promise.resolve()
      : new Promise((resolve) =>
          base.invalidation.signal.addEventListener('abort', () => resolve(), { once: true })
        ),
    connect: (target) => {
      const socket = new BrowserNetworkDeferredSocket()
      if (!isValid()) {
        queueMicrotask(() => socket.fail(new Error('browser_tunnel_execution_host_stale')))
        return socket
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const opening = lifetime.beginChannelOpen()
      try {
        base.connection.forwardOut(
          client,
          socket,
          '127.0.0.1',
          0,
          target.host,
          target.port,
          (error, channel) => {
            // Deferred socket close is synthetic; only the raw channel proves local retirement.
            if (error) {
              opening.close()
            } else {
              trackSshConnectionChannelLifetime(opening, channel)
            }
            queueMicrotask(() => {
              try {
                if (error) {
                  socket.fail(error)
                } else if (!isValid()) {
                  channel.close()
                  socket.fail(new Error('browser_tunnel_execution_host_stale'))
                } else {
                  socket.attach(channel)
                }
              } catch (failure) {
                opening.markUnverifiable(asError(failure))
                socket.fail(asError(failure))
              }
            })
          }
        )
      } catch (error) {
        if (error instanceof SshConnectionWorkAdmissionClosedError) {
          opening.close()
        } else {
          opening.markUnverifiable(asError(error))
        }
        queueMicrotask(() => socket.fail(asError(error)))
      }
      return socket
    },
    close
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
