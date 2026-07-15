import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { restartCancelledWatcherChild } from './parcel-watcher-cancellation-restart'
import { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import { getWatcherProcessEntryPath } from './parcel-watcher-entry-path'
import { removeWatcherCanaryDirectory } from './parcel-watcher-canary-directory'
import * as termination from './parcel-watcher-child-termination'
import { launchWatcherChild } from './parcel-watcher-child-launch'
import { sendToWatcherChild } from './parcel-watcher-child-messaging'
import {
  recoverWatcherRecordsAfterChildGone,
  terminateDisconnectedWatcherChild
} from './parcel-watcher-child-recovery'
import { resetWatcherChildRegistryForTest } from './parcel-watcher-child-registry'
import { WatcherSupervisorCapacityWait } from './parcel-watcher-supervisor-capacity-wait'
import { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'
import { cancelInterruptedWatcherSubscribe } from './parcel-watcher-interrupted-cancellation'
import {
  type PendingWatcherUnsubscribe,
  reportWatcherTerminalError,
  resolvePendingWatcherUnsubscribes
} from './parcel-watcher-host-subscriptions'
import { cancelPendingWatcherSubscribe } from './parcel-watcher-pending-cancellation'
import type { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  WatcherProcessSubscribeOptions,
  WatcherToHostMessage
} from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription,
  WatcherProcessSubscriptionRecord
} from './parcel-watcher-process-subscription'
import type { WatcherProcessSupervisorOptions } from './parcel-watcher-process-supervisor-options'
import {
  sendWatcherSubscribe,
  subscribeThroughWatcherSupervisor
} from './parcel-watcher-supervisor-subscribe'
import { disposeWatcherSupervisor } from './parcel-watcher-supervisor-disposal'
import { handleWatcherSupervisorMessage } from './parcel-watcher-supervisor-message'

export class WatcherProcessSupervisor {
  private child: ChildProcess | null = null
  private nextSubscriptionId = 1
  private readonly crashFuse = new WatcherProcessCrashFuse()
  private shutdownRequested = false
  private canaryDir: string | null = null
  private terminatingChild: ChildProcess | null = null
  private readonly terminationQueue = new termination.WatcherTerminationQueue()
  private readonly records = new Map<number, WatcherProcessSubscriptionRecord>()
  private readonly pendingUnsubscribes = new Map<number, PendingWatcherUnsubscribe>()
  private readonly cancelledSubscribes = new WatcherCancellationTracker()
  private readonly capacityWait = new WatcherSupervisorCapacityWait()

  constructor(private readonly options: WatcherProcessSupervisorOptions = {}) {}

  subscribe(
    dir: string,
    callback: WatcherProcessCallback,
    opts: WatcherProcessSubscribeOptions,
    hooks: WatcherProcessHooks = {}
  ): Promise<WatcherProcessSubscription> {
    const queued = this.terminationQueue.waitFor(() => this.subscribe(dir, callback, opts, hooks))
    if (queued) {
      return queued
    }
    return this.capacityWait.run(
      subscribeThroughWatcherSupervisor({
        dir,
        callback,
        opts,
        hooks,
        shutdownRequested: this.shutdownRequested,
        entryPath: this.options.entryPath ?? getWatcherProcessEntryPath(),
        useInProcessVitestFallback: this.options.useInProcessVitestFallback ?? true,
        allocateId: () => this.nextSubscriptionId++,
        records: this.records,
        pendingUnsubscribes: this.pendingUnsubscribes,
        ensureWatcherProcess: (entryPath) => this.ensureWatcherProcess(entryPath),
        getChild: () => this.child,
        getTerminationPromise: () => this.terminationQueue.getCurrent(),
        killWatcherChildIfIdle: () => this.killWatcherChildIfIdle(),
        terminateUnavailableChild: (child) => this.terminateUnavailableChild(child),
        sendSubscribe: sendWatcherSubscribe,
        sendToChild: sendToWatcherChild,
        cancelPendingSubscribe: (record, error) => this.cancelPendingSubscribe(record, error)
      }),
      () => this.subscribe(dir, callback, opts, hooks),
      hooks.signal
    )
  }

  dispose(): void {
    this.shutdownRequested = true
    this.capacityWait.dispose()
    const proc = this.child
    this.child = null
    this.canaryDir = disposeWatcherSupervisor(
      proc,
      this.records,
      this.pendingUnsubscribes,
      this.cancelledSubscribes,
      this.canaryDir
    )
  }

  resetForTest(): void {
    this.dispose()
    this.shutdownRequested = false
    this.terminatingChild = null
    this.terminationQueue.resetForTest()
    this.crashFuse.reset()
    resetWatcherChildRegistryForTest()
  }

  private ensureWatcherProcess(
    entryPath = this.options.entryPath ?? getWatcherProcessEntryPath()
  ): ChildProcess | null {
    if (this.shutdownRequested || this.terminatingChild) {
      return null
    }
    if (this.child?.connected) {
      return this.child
    }
    if (this.crashFuse.isOpen()) {
      return null
    }
    if (!existsSync(entryPath)) {
      console.error(`[parcel-watcher-process] entry not found at ${entryPath}; refusing fail-open`)
      return null
    }
    const launched = launchWatcherChild(
      entryPath,
      this.canaryDir,
      (child, message) => {
        if (this.child === child) {
          this.handleChildMessage(message)
        }
      },
      (child, code, signal) => this.handleChildGone(child, code, signal)
    )
    if (!launched) {
      this.canaryDir = null
      return null
    }
    this.canaryDir = launched.canaryDir
    this.child = launched.child
    return launched.child
  }

  private handleChildMessage(message: WatcherToHostMessage): void {
    const child = this.child
    handleWatcherSupervisorMessage(message, {
      records: this.records,
      pendingUnsubscribes: this.pendingUnsubscribes,
      cancelledSubscribes: this.cancelledSubscribes,
      child,
      cancelPendingSubscribe: (record, error) => this.cancelPendingSubscribe(record, error),
      cancelInterruptedSubscribe: (record, error) =>
        cancelInterruptedWatcherSubscribe({
          record,
          error,
          records: this.records,
          reportTerminalError: reportWatcherTerminalError,
          restartChild: () => this.restartAfterCancelledSubscribe(child)
        }),
      restartAfterCancelledSubscribe: (child) => this.restartAfterCancelledSubscribe(child),
      terminateUnavailableChild: (child) => {
        if (child) {
          this.terminateUnavailableChild(child)
        }
      },
      killWatcherChildIfIdle: () =>
        termination.ignoreWatcherTermination(this.killWatcherChildIfIdle())
    })
  }

  private handleChildGone(
    proc: ChildProcess,
    code?: number | null,
    signal?: NodeJS.Signals | null
  ): void {
    if (this.child !== proc) {
      return
    }
    if (code === undefined) {
      this.terminateUnavailableChild(proc)
      return
    }
    this.child = null
    this.cancelledSubscribes.completeForChild(proc)
    resolvePendingWatcherUnsubscribes(this.pendingUnsubscribes)
    recoverWatcherRecordsAfterChildGone(
      this.records,
      this.crashFuse,
      this.shutdownRequested,
      () => this.ensureWatcherProcess(),
      sendWatcherSubscribe,
      () => {
        this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
      },
      code,
      signal
    )
  }

  private terminateUnavailableChild(requestedChild: ChildProcess | null): Promise<void> {
    const currentTermination = this.terminationQueue.getCurrent()
    if (currentTermination) {
      return currentTermination
    }
    const proc = requestedChild ?? this.terminatingChild
    if (!proc) {
      return Promise.resolve()
    }
    this.child = null
    this.terminatingChild = proc
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
    return this.terminationQueue.track(
      terminateDisconnectedWatcherChild(
        proc,
        this.records,
        this.pendingUnsubscribes,
        this.cancelledSubscribes,
        this.crashFuse,
        (exited) => {
          this.terminatingChild = null
          if (!exited) {
            this.shutdownRequested = true
          }
          return !this.shutdownRequested
        },
        () => this.ensureWatcherProcess(),
        sendWatcherSubscribe,
        () => {
          this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
        }
      )
    )
  }

  private killWatcherChildIfIdle(): Promise<void> {
    const terminationPromise = this.terminationQueue.getCurrent()
    if (terminationPromise) {
      return terminationPromise
    }
    const proc = this.child
    if (!proc || this.records.size > 0) {
      return Promise.resolve()
    }
    this.child = null
    this.terminatingChild = proc
    // Why: destructive Windows cleanup must await exit to release directory handles.
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
    return this.terminationQueue.track(
      termination.terminateIdleWatcherChild(proc, this.pendingUnsubscribes, () => {
        // Why: an idle child owns zero records, so a missed exit deadline has no
        // double-watch hazard; the child keeps its capacity reservation until
        // physical exit, and poisoning this supervisor would permanently end
        // local watching — the shared singleton has no retire-and-replace path.
        this.terminatingChild = null
      })
    )
  }

  private cancelPendingSubscribe(
    record: WatcherProcessSubscriptionRecord,
    error: WatcherProcessFailure
  ): void {
    cancelPendingWatcherSubscribe({
      record,
      error,
      records: this.records,
      child: this.child,
      cancelledSubscribes: this.cancelledSubscribes,
      onChildUnavailable: (child) => this.terminateUnavailableChild(child),
      restartChild: (child) => this.restartAfterCancelledSubscribe(child),
      sendCancel: (child, id) => sendToWatcherChild(child, { op: 'cancel-subscribe', id })
    })
  }

  private restartAfterCancelledSubscribe(proc: ChildProcess | null): Promise<void> {
    const activeTermination = this.terminationQueue.getCurrent()
    if (activeTermination || !proc || !this.cancelledSubscribes.beginRestart(proc)) {
      return activeTermination ?? Promise.resolve()
    }
    if (this.child === proc) {
      this.child = null
    }
    this.terminatingChild = proc
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
    return this.terminationQueue.track(
      restartCancelledWatcherChild(
        proc,
        this.records,
        this.pendingUnsubscribes,
        this.cancelledSubscribes,
        (exited) => {
          this.terminatingChild = null
          if (!exited) {
            this.shutdownRequested = true
          }
          return !this.shutdownRequested
        },
        () => this.ensureWatcherProcess(),
        sendWatcherSubscribe,
        () => {
          this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
        }
      )
    )
  }
}
