/**
 * Watching for stop requests addressed to this orcad.
 *
 * Two listeners share one shutdown: the plain slot request (`.orcad-stop-request` beside
 * `orcad.js`, consumed by unlinking it) and the instance-bound managed request in the data
 * root, which is validated and kept as evidence until the completion command proves exit.
 */
import { unlinkSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  ORCAD_STOP_REQUEST_FILENAME,
  type OrcadManagedStopContext,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import {
  orcadManagedStopRequestPath,
  validateOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import { claimOrcadManagedStopDecision } from './orcad-managed-stop-decision'

export type OrcadStopRequestListener = { close(): void }

const DEFAULT_POLL_INTERVAL_MS = 1_000

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** `consume` returns true when the request should stop orcad; a missing file throws ENOENT. */
function listenForRequest(
  requestPath: string,
  consume: (path: string) => boolean,
  onRequest: () => void,
  pollIntervalMs: number
): OrcadStopRequestListener {
  let closed = false
  let lastFailure: string | null = null
  const check = (): void => {
    if (closed) {
      return
    }
    try {
      if (!consume(requestPath)) {
        return
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        // Polling retries every interval; report each distinct refusal once.
        const failure = error instanceof Error ? error.message : String(error)
        if (failure !== lastFailure) {
          lastFailure = failure
          console.error(`[orcad] refused stop request at ${requestPath}:`, error)
        }
      }
      return
    }
    closed = true
    stop()
    onRequest()
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(dirname(requestPath), (_event, changed) => {
      if (!changed || basename(String(changed)) === basename(requestPath)) {
        check()
      }
    })
    watcher.on('error', (error) => console.error('[orcad] stop-request watcher failed:', error))
    watcher.unref()
  } catch (error) {
    // The poll below still delivers requests; a watcher only makes them prompt.
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(check, pollIntervalMs)
  poll.unref()
  const stop = (): void => {
    watcher?.close()
    clearInterval(poll)
  }
  // Covers a request written before this listener was installed.
  check()
  return {
    close: () => {
      closed = true
      stop()
    }
  }
}

export function installOrcadStopRequestListeners(
  onRequest: () => void,
  options: {
    installRoot: string
    managedStop?: OrcadManagedStopContext
    /** Runs once for a validated managed request before the stop; it cannot prevent it. */
    beforeManagedStop?: (request: OrcadManagedStopRequest) => Promise<void>
    pollIntervalMs?: number
  }
): OrcadStopRequestListener {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const listeners = [
    listenForRequest(
      join(options.installRoot, ORCAD_STOP_REQUEST_FILENAME),
      (path) => {
        unlinkSync(path)
        return true
      },
      onRequest,
      pollIntervalMs
    )
  ]
  const managedStop = options.managedStop
  if (managedStop) {
    const prepare = options.beforeManagedStop ?? (async () => {})
    listeners.push(
      listenForRequest(
        orcadManagedStopRequestPath(managedStop.instance),
        (path) => {
          const request = validateOrcadManagedStopRequest(managedStop, path)
          // A cancelled request is never acted on; keep listening for the next transaction.
          if (claimOrcadManagedStopDecision(request, 'dispatched') === 'canceled') {
            throw new Error('orcad_managed_stop_canceled')
          }
          close()
          // Preparation is best effort: whatever it reports, the stop proceeds.
          void prepare(request)
            .catch((error: unknown) =>
              console.error('[orcad] managed stop preparation failed:', error)
            )
            .finally(onRequest)
          return false
        },
        onRequest,
        pollIntervalMs
      )
    )
  }
  const close = (): void => {
    for (const listener of listeners) {
      listener.close()
    }
  }
  return { close }
}
