import { isWatcherProcessFailure } from '../../../ipc/filesystem/watcher-process/parcel-watcher-process-failure'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { createFileWatchEventBatcher } from './file-watch-event-batcher'
import { dirListingPageCache } from './files-read-dir-page'
import type { FileWatchBatchCadence } from '../../../../shared/rpc-contract/files-target-params'

export async function runFileWatchStream(args: {
  runtime: OrcaRuntimeService
  worktree: string
  batchCadence?: FileWatchBatchCadence
  connectionId?: string
  signal?: AbortSignal
  subscriptionId: string
  emit: (event: unknown) => void
}): Promise<void> {
  if (args.signal?.aborted) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let setupFailed = false
    let watchReady = false
    let unwatch: (() => Promise<void>) | null = null
    let terminalError: Error | null = null
    let setupPromise: Promise<() => Promise<void>> | null = null
    let cleanupPromise: Promise<void> | null = null
    let logicalCleanupStarted = false
    let endEmitted = false
    const setupAbortController = new AbortController()
    const eventBatcher = createFileWatchEventBatcher(args.worktree, args.emit, args.batchCadence)
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      args.signal?.removeEventListener('abort', handleAbort)
      callback()
    }
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) {
        return cleanupPromise
      }
      const attempt = (async () => {
        if (!logicalCleanupStarted) {
          logicalCleanupStarted = true
          // Mark cleanup complete before emitting; synchronous transport abort can re-enter and duplicate error/end.
          if (!setupFailed) {
            settle(resolve)
          }
          setupAbortController.abort()
          if (terminalError) {
            // Flush recovery's final overflow so the stream never ends on a known stale snapshot.
            eventBatcher.flush()
            eventBatcher.dispose()
            args.emit({ type: 'error', message: terminalError.message })
          } else if (watchReady) {
            eventBatcher.flush()
            eventBatcher.dispose()
          } else {
            // Cancellation before ready must discard the partial crawl queued during setup.
            eventBatcher.dispose()
          }
        }
        try {
          if (!unwatch && setupPromise) {
            try {
              unwatch = await setupPromise
            } catch (error) {
              if (!setupAbortController.signal.aborted) {
                throw error
              }
            }
          }
          await unwatch?.()
        } catch (error) {
          if (isWatcherProcessFailure(error) && error.physicalExit) {
            args.runtime.retrySubscriptionCleanupAfter(
              args.subscriptionId,
              cleanup,
              error.physicalExit
            )
          }
          throw error
        } finally {
          if (!setupFailed && !endEmitted) {
            endEmitted = true
            args.emit({ type: 'end' })
          }
        }
      })()
      cleanupPromise = attempt
      void attempt.catch(() => {
        if (cleanupPromise === attempt) {
          // Reset rejected cleanup for later transient retries; only concurrent callers share it.
          cleanupPromise = null
        }
      })
      return attempt
    }
    const handleTerminalError = (error: Error): void => {
      if (settled || terminalError) {
        return
      }
      terminalError = error
      args.runtime.cleanupSubscription(args.subscriptionId)
    }
    function handleAbort(): void {
      args.runtime.cleanupSubscription(args.subscriptionId)
    }

    args.signal?.addEventListener('abort', handleAbort, { once: true })
    // Register cancellation before ready: native setup may wait indefinitely for global child capacity.
    args.runtime.registerSubscriptionCleanup(args.subscriptionId, cleanup, args.connectionId)
    args.emit({ type: 'starting', subscriptionId: args.subscriptionId })
    setupPromise = args.runtime.watchFileExplorer(
      args.worktree,
      (events) => {
        // Why: a later page must not serve a file this change deleted from a cached listing.
        dirListingPageCache.forgetWorkspace(args.worktree)
        eventBatcher.push(events)
      },
      handleTerminalError,
      setupAbortController.signal
    )
    void setupPromise
      .then((nextUnwatch) => {
        if (cleanupPromise || settled) {
          return
        }
        unwatch = nextUnwatch
        watchReady = true
        args.emit({ type: 'ready', subscriptionId: args.subscriptionId })
      })
      .catch(async (error) => {
        if (cleanupPromise || settled || setupAbortController.signal.aborted) {
          return
        }
        setupFailed = true
        await args.runtime.cleanupSubscriptionAndWait(args.subscriptionId).catch((cleanupError) => {
          console.error('[runtime-files.watch] failed-setup cleanup failed', cleanupError)
        })
        settle(() => reject(error))
      })
    if (args.signal?.aborted) {
      handleAbort()
    }
  })
}
