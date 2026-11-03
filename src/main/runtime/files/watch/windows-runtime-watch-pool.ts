import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isWatcherProcessFailure } from '../../../ipc/filesystem/watcher-process/parcel-watcher-process-failure'
import { watchWindowsRuntimeFileExplorer } from './windows-file-watch'

type Subscriber = {
  onEvents: (events: FsChangeEvent[]) => void
  onError: (error: Error) => void
}

type WindowsRootWatch = {
  subscribers: Set<Subscriber>
  close: () => Promise<void>
  closing: Promise<void> | null
  closeError: Error | null
}

export class WindowsRuntimeWatchPool {
  private readonly roots = new Map<string, WindowsRootWatch>()

  async watch(
    rootPath: string,
    onEvents: Subscriber['onEvents'],
    onError: Subscriber['onError'],
    signal?: AbortSignal
  ): Promise<() => Promise<void>> {
    throwIfSignalAborted(signal)
    const key = normalizeRuntimePathForComparison(rootPath)
    let root = this.roots.get(key)
    if (root?.closing) {
      await waitForPromiseWithSignal(root.closing, signal)
      return this.watch(rootPath, onEvents, onError, signal)
    }
    if (root?.closeError) {
      throw root.closeError
    }
    if (!root) {
      root = this.createRoot(key, rootPath)
      this.roots.set(key, root)
    }
    const ownedRoot = root
    const subscriber = { onEvents, onError }
    ownedRoot.subscribers.add(subscriber)
    let releasePromise: Promise<void> | undefined
    return () => {
      if (releasePromise) {
        return releasePromise
      }
      ownedRoot.subscribers.delete(subscriber)
      if (ownedRoot.subscribers.size > 0) {
        return Promise.resolve()
      }
      const attempt = this.closeRoot(key, ownedRoot)
      releasePromise = attempt
      void attempt.catch(() => {
        releasePromise = undefined
      })
      return attempt
    }
  }

  private createRoot(key: string, rootPath: string): WindowsRootWatch {
    const subscribers = new Set<Subscriber>()
    const close = watchWindowsRuntimeFileExplorer(
      rootPath,
      (events) => {
        for (const subscriber of Array.from(subscribers)) {
          if (subscribers.has(subscriber)) {
            subscriber.onEvents(events)
          }
        }
      },
      (error) => {
        if (this.roots.get(key)?.subscribers === subscribers) {
          this.roots.delete(key)
        }
        const failedSubscribers = Array.from(subscribers)
        subscribers.clear()
        for (const subscriber of failedSubscribers) {
          subscriber.onError(error)
        }
      }
    )
    return { subscribers, close, closing: null, closeError: null }
  }

  private closeRoot(key: string, root: WindowsRootWatch): Promise<void> {
    if (root.closing) {
      return root.closing
    }
    const forget = (): void => {
      if (this.roots.get(key) === root) {
        this.roots.delete(key)
      }
    }
    const attempt = root.close().then(forget)
    root.closing = attempt
    void attempt.catch((error: unknown) => {
      root.closeError = error instanceof Error ? error : new Error(String(error))
      // A timed-out close still owns native locks until its physical exit.
      root.closing =
        isWatcherProcessFailure(error) && error.physicalExit
          ? error.physicalExit.then(forget)
          : null
    })
    return attempt
  }
}
