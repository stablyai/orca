import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { RemoteRuntimeRequestConnection } from '../../../shared/remote-runtime/requests/remote-runtime-request-connection'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'

export function createRequestConnection(
  pairedConnection: PairedRuntimeConnection
): RemoteRuntimeRequestConnection {
  return new RemoteRuntimeRequestConnection(
    pairedConnection,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
}

/**
 * An unused request socket to a WSL host holds its own wsl.exe bridge (about 21 MB on Windows),
 * while the shared-control socket stays open anyway. It also carries terminal keystrokes, and a
 * redial costs about 90-145 ms against 3-4 ms warm (real-WSL lane), so close it only once the
 * host has been truly idle; a first keystroke after that pays one redial.
 */
export const WSL_HOST_REQUEST_IDLE_CLOSE_MS = 5 * 60_000

type Closable = { close(): void }
type IdleState = { pending: number; timer: ReturnType<typeof setTimeout> | null }

const idleStates = new WeakMap<Closable, IdleState>()

function isWslHost(environmentId: string): boolean {
  return getWslHostService()?.recordForEnvironment(environmentId) != null
}

/** WSL hosts only: closes the request socket once no request has used it for a while. */
export function trackWslHostRequestIdle<T>(
  environmentId: string,
  connection: Closable,
  request: Promise<T>,
  isWslHostEnvironment: (environmentId: string) => boolean = isWslHost
): Promise<T> {
  if (!isWslHostEnvironment(environmentId)) {
    return request
  }
  let state = idleStates.get(connection)
  if (!state) {
    state = { pending: 0, timer: null }
    idleStates.set(connection, state)
  }
  const tracked = state
  tracked.pending += 1
  if (tracked.timer) {
    clearTimeout(tracked.timer)
    tracked.timer = null
  }
  const settle = (): void => {
    tracked.pending -= 1
    if (tracked.pending > 0) {
      return
    }
    tracked.timer = setTimeout(() => {
      tracked.timer = null
      // Closing rejects pending requests, so only an idle socket is closed.
      if (tracked.pending === 0) {
        connection.close()
      }
    }, WSL_HOST_REQUEST_IDLE_CLOSE_MS)
    tracked.timer.unref?.()
  }
  request.then(settle, settle)
  return request
}
