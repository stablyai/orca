import type { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import type { CodexAppServerConnectionHandlers } from '../codex-app-server-connection-types'
import { CodexAppServerTimeoutError } from '../codex-app-server-request-error'

/** A request with no answer, and no other frame from the server, for this long means it hung. */
export const CODEX_SHARED_SERVER_HUNG_MS = 120_000

/** Opens a shared server that retires itself once it stops answering: a request stays
 *  outstanding while no frame arrives. Its chats end as an unexpected exit and each reconnects
 *  to a fresh server on its next message. */
export function retiringHungCodexServers(
  connect: typeof spawnCodexAppServerConnection
): typeof spawnCodexAppServerConnection {
  return async (launch, handlers = {}, spawnImpl) => {
    let frames = 0
    const heard =
      <A extends unknown[]>(handler?: (...args: A) => void) =>
      (...args: A): void => {
        frames += 1
        handler?.(...args)
      }
    const connection = await connect(
      launch,
      {
        ...handlers,
        onNotification: heard(handlers.onNotification),
        onServerRequest: heard(handlers.onServerRequest),
        onUnhandledFrame: heard(handlers.onUnhandledFrame)
      } satisfies CodexAppServerConnectionHandlers,
      spawnImpl
    )
    const send = connection.request.bind(connection)
    connection.request = (method, params, options = {}) => {
      const framesBefore = frames
      const timer = setTimeout(() => {
        if (frames === framesBefore && !connection.closed) {
          console.warn(
            `[codex-shared-server] pid ${connection.pid ?? '?'} answered nothing for ${CODEX_SHARED_SERVER_HUNG_MS} ms after ${method}; retiring it`
          )
          void connection.close()
        }
      }, CODEX_SHARED_SERVER_HUNG_MS)
      timer.unref?.()
      const sent = send(method, params, { ...options, onReply: heard(options.onReply) })
      sent.then(
        () => clearTimeout(timer),
        (error: unknown) => {
          // A request that timed out still finds a hang if the server stays silent.
          if (!(error instanceof CodexAppServerTimeoutError)) {
            clearTimeout(timer)
          }
        }
      )
      return sent
    }
    return connection
  }
}
