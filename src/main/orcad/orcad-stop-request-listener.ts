// Consume slot stop files; retain validated instance-bound requests as evidence until exit is proven.
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
import { withdrawOrcadManagedStopRequest } from './orcad-managed-stop-cancellation'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export type OrcadStopRequestListener = { close(): void }

const DEFAULT_POLL_INTERVAL_MS = 1_000

function listenForRequest<T>(
  requestPath: string,
  consume: (path: string) => T | null,
  onRequest: (request: T) => void,
  pollIntervalMs: number
): OrcadStopRequestListener {
  let closed = false
  let lastFailure: string | null = null
  const check = (): void => {
    if (closed) {
      return
    }
    let request: T | null
    try {
      request = consume(requestPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        const failure = error instanceof Error ? error.message : String(error)
        if (failure !== lastFailure) {
          lastFailure = failure
          console.error(`[orcad] refused stop request at ${requestPath}:`, error)
        }
      }
      return
    }
    if (request === null) {
      return
    }
    closed = true
    stop()
    onRequest(request)
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
    // Polling still delivers requests when filesystem watching fails.
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(check, pollIntervalMs)
  poll.unref()
  const stop = (): void => {
    watcher?.close()
    clearInterval(poll)
  }
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
    /** Best-effort preparation runs before shutdown and cannot prevent it. */
    beforeManagedStop?: (request: OrcadManagedStopRequest) => Promise<void>
    pollIntervalMs?: number
  }
): OrcadStopRequestListener {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  // Initial checks can close listeners synchronously before setup returns.
  const listeners: OrcadStopRequestListener[] = []
  const close = (): void => {
    for (const listener of listeners) {
      listener.close()
    }
  }
  listeners.push(
    listenForRequest(
      join(options.installRoot, ORCAD_STOP_REQUEST_FILENAME),
      (path) => {
        unlinkSync(path)
        return true
      },
      () => onRequest(),
      pollIntervalMs
    )
  )
  const managedStop = options.managedStop
  if (managedStop) {
    const prepare = options.beforeManagedStop ?? (async () => {})
    listeners.push(
      listenForRequest(
        orcadManagedStopRequestPath(managedStop.instance),
        (path) => {
          const request = validateOrcadManagedStopRequest(managedStop, path)
          if (claimOrcadManagedStopDecision(request, 'dispatched') === 'canceled') {
            // Withdraw canceled requests so later transactions can publish their own.
            withdrawOrcadManagedStopRequest(request)
            throw new Error('orcad_managed_stop_canceled')
          }
          return request
        },
        (request) => {
          close()
          void prepare(request)
            .catch((error: unknown) =>
              console.error('[orcad] managed stop preparation failed:', error)
            )
            .finally(onRequest)
        },
        pollIntervalMs
      )
    )
  }
  return { close }
}
