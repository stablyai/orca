/**
 * Single-flight coordinator for fs.listFiles full-tree scans (#7721).
 *
 * Why: rapid workspace switching used to stack N concurrent full-tree scans
 * on the single-threaded relay and its one SSH channel, starving small
 * interactive fs.readDir/fs.stat requests past their 30s timeout. This
 * coordinator guarantees at most one scan in flight per client:
 *   - a request for the same root/excludes joins the in-flight scan
 *     (Quick Open + file-explorer filter share one scan),
 *   - a request for a different root supersedes it — the old scan is aborted
 *     and its request fails fast instead of running to completion (this also
 *     protects against older Orca clients that never send rpc.cancel),
 *   - when every joined requester cancels (rpc.cancel / client detach), the
 *     scan is aborted so abandoned work stops immediately.
 */
import {
  FileListingCancelledError,
  fileListingCancellationError
} from '../shared/file-listing-cancellation'

export const LIST_FILES_SUPERSEDED_MESSAGE = 'File listing superseded by a newer request'

type ScanEntry = {
  key: string
  controller: AbortController
  promise: Promise<string[]>
  attachedCount: number
}

export class ListFilesScanCoordinator {
  private readonly scansByClient = new Map<number, ScanEntry>()

  run(opts: {
    clientId: number
    key: string
    signal?: AbortSignal
    start: (signal: AbortSignal) => Promise<string[]>
  }): Promise<string[]> {
    const { clientId, key, signal, start } = opts
    if (signal?.aborted) {
      return Promise.reject(fileListingCancellationError(signal))
    }

    const existing = this.scansByClient.get(clientId)
    if (existing && existing.key === key && !existing.controller.signal.aborted) {
      return this.attach(existing, signal)
    }
    if (existing) {
      existing.controller.abort(new FileListingCancelledError(LIST_FILES_SUPERSEDED_MESSAGE))
    }

    const controller = new AbortController()
    const entry: ScanEntry = {
      key,
      controller,
      promise: Promise.resolve([]),
      attachedCount: 0
    }
    this.scansByClient.set(clientId, entry)
    entry.promise = start(controller.signal).finally(() => {
      if (this.scansByClient.get(clientId) === entry) {
        this.scansByClient.delete(clientId)
      }
    })
    return this.attach(entry, signal)
  }

  private attach(entry: ScanEntry, signal?: AbortSignal): Promise<string[]> {
    entry.attachedCount++
    if (signal) {
      const onAbort = (): void => {
        entry.attachedCount--
        // Why: only stop the shared scan when nobody is left waiting on it —
        // one requester cancelling must not break a coalesced sibling.
        if (entry.attachedCount <= 0) {
          entry.controller.abort(fileListingCancellationError(signal))
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.promise
        .finally(() => signal.removeEventListener('abort', onAbort))
        .catch(() => {
          /* rejection is surfaced through the promise returned below */
        })
    }
    return entry.promise
  }
}
