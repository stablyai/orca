import type { ChildProcess } from 'node:child_process'
import { restartCancelledWatcherChild } from './parcel-watcher-cancellation-restart'
import { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import { getWatcherProcessEntryPath, watcherProcessEntryExists } from './parcel-watcher-entry-path'
import { WatcherChildSlot } from './parcel-watcher-child-slot'
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
import { WatcherOwnedChildren } from './parcel-watcher-owned-children'

export class WatcherProcessSupervisor {
  private nextSubscriptionId = 1
  private readonly crashFuse = new WatcherProcessCrashFuse()
  private shutdown = { requested: false, disposalRevision: 0 }
  private readonly slot = new WatcherChildSlot()
  private readonly terminationQueue = new termination.WatcherTerminationQueue()
  private readonly records = new Map<number, WatcherProcessSubscriptionRecord>()
  private readonly pendingUnsubscribes = new Map<number, PendingWatcherUnsubscribe>()
  private readonly cancelledSubscribes = new WatcherCancellationTracker()
  private readonly capacityWait = new WatcherSupervisorCapacityWait()
  private ownedChildren = new WatcherOwnedChildren()

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
        shutdownRequested: this.shutdown.requested,
        entryPath: this.options.entryPath ?? getWatcherProcessEntryPath(),
        useInProcessVitestFallback: this.options.useInProcessVitestFallback ?? true,
        allocateId: () => this.nextSubscriptionId++,
        records: this.records,
        pendingUnsubscribes: this.pendingUnsubscribes,
        ensureWatcherProcess: (entryPath) => this.ensureWatcherProcess(entryPath),
        getChild: () => this.slot.child,
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
    this.shutdown.requested = true
    this.shutdown.disposalRevision++
    this.capacityWait.dispose()
    const proc = this.slot.child
    this.slot.child = null
    this.slot.canaryDir = disposeWatcherSupervisor(
      proc,
      this.records,
      this.pendingUnsubscribes,
      this.cancelledSubscribes,
      this.slot.canaryDir
    )
  }

  resetForTest(): void {
    this.dispose()
    this.ownedChildren = new WatcherOwnedChildren()
    this.shutdown.requested = false
    this.slot.terminating = null
    this.terminationQueue.resetForTest()
    this.crashFuse.reset()
    resetWatcherChildRegistryForTest()
  }

  disposeAndWait = (): Promise<void> => this.ownedChildren.disposeAndWait(() => this.dispose())

  private ensureWatcherProcess(
    entryPath = this.options.entryPath ?? getWatcherProcessEntryPath()
  ): ChildProcess | null {
    if (this.shutdown.requested || this.slot.terminating) {
      return null
    }
    if (this.slot.child?.connected) {
      return this.slot.child
    }
    if (this.crashFuse.isOpen()) {
      return null
    }
    if (!watcherProcessEntryExists(entryPath)) {
      return null
    }
    const launched = launchWatcherChild(
      entryPath,
      this.slot.canaryDir,
      (child, message) => {
        if (this.slot.child === child) {
          this.handleChildMessage(message)
        }
      },
      (child, code, signal) => this.handleChildGone(child, code, signal)
    )
    if (!launched) {
      this.slot.canaryDir = null
      return null
    }
    this.slot.canaryDir = launched.canaryDir
    this.slot.child = this.ownedChildren.track(launched.child)
    return launched.child
  }

  private handleChildMessage(message: WatcherToHostMessage): void {
    const child = this.slot.child
    const disposalRevision = this.shutdown.disposalRevision
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
      shouldReportTerminalError: () => this.shutdown.disposalRevision === disposalRevision,
      killWatcherChildIfIdle: () =>
        termination.ignoreWatcherTermination(this.killWatcherChildIfIdle())
    })
  }

  private handleChildGone(
    proc: ChildProcess,
    code?: number | null,
    signal?: NodeJS.Signals | null
  ): void {
    if (this.slot.child !== proc) {
      return
    }
    if (code === undefined) {
      this.terminateUnavailableChild(proc)
      return
    }
    this.slot.child = null
    this.cancelledSubscribes.completeForChild(proc)
    resolvePendingWatcherUnsubscribes(this.pendingUnsubscribes)
    recoverWatcherRecordsAfterChildGone(
      this.records,
      this.crashFuse,
      this.shutdown.requested,
      () => this.ensureWatcherProcess(),
      sendWatcherSubscribe,
      () => this.slot.removeCanary(),
      code,
      signal
    )
  }

  private terminateUnavailableChild(requestedChild: ChildProcess | null): Promise<void> {
    const currentTermination = this.terminationQueue.getCurrent()
    if (currentTermination) {
      return currentTermination
    }
    const proc = requestedChild ?? this.slot.terminating
    if (!proc) {
      return Promise.resolve()
    }
    this.slot.child = null
    this.slot.beginTermination(proc)
    return this.terminationQueue.track(
      terminateDisconnectedWatcherChild(
        proc,
        this.records,
        this.pendingUnsubscribes,
        this.cancelledSubscribes,
        this.crashFuse,
        (exited) => {
          this.slot.terminating = null
          if (!exited) {
            this.shutdown.requested = true
          }
          return !this.shutdown.requested
        },
        () => this.ensureWatcherProcess(),
        sendWatcherSubscribe,
        () => this.slot.removeCanary()
      )
    )
  }

  private killWatcherChildIfIdle(): Promise<void> {
    const terminationPromise = this.terminationQueue.getCurrent()
    if (terminationPromise) {
      return terminationPromise
    }
    const proc = this.slot.child
    if (!proc || this.records.size > 0) {
      return Promise.resolve()
    }
    this.slot.child = null
    this.slot.beginTermination(proc)
    return this.terminationQueue.track(
      termination.terminateIdleWatcherChild(proc, this.pendingUnsubscribes, () => {
        this.slot.terminating = null
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
      child: this.slot.child,
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
    if (this.slot.child === proc) {
      this.slot.child = null
    }
    this.slot.beginTermination(proc)
    return this.terminationQueue.track(
      restartCancelledWatcherChild(
        proc,
        this.records,
        this.pendingUnsubscribes,
        this.cancelledSubscribes,
        (exited) => {
          this.slot.terminating = null
          if (!exited) {
            this.shutdown.requested = true
          }
          return !this.shutdown.requested
        },
        () => this.ensureWatcherProcess(),
        sendWatcherSubscribe,
        () => this.slot.removeCanary()
      )
    )
  }
}
