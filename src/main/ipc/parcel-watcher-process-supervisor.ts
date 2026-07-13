import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getWatcherProcessEntryPath } from './parcel-watcher-entry-path'
import { removeWatcherCanaryDirectory } from './parcel-watcher-canary-directory'
import { launchWatcherChild } from './parcel-watcher-child-launch'
import { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'
import {
  disposeWatcherSupervisorSubscriptions,
  failAllWatcherSubscriptions,
  handleWatcherHostMessage,
  reportWatcherTerminalError,
  resolvePendingWatcherUnsubscribes
} from './parcel-watcher-host-subscriptions'
import {
  resetPendingSubscribeAttempt,
  startInterruptedSubscribeTimeout,
  startPendingSubscribeTimeout,
  takePendingSubscribe
} from './parcel-watcher-pending-subscribe'
import { watcherHostFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  HostToWatcherMessage,
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
import { subscribeThroughWatcherSupervisor } from './parcel-watcher-supervisor-subscribe'

export type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
export type { WatcherProcessSupervisorOptions } from './parcel-watcher-process-supervisor-options'

export class WatcherProcessSupervisor {
  private child: ChildProcess | null = null
  private nextSubscriptionId = 1
  private readonly crashFuse = new WatcherProcessCrashFuse()
  private shutdownRequested = false
  private canaryDir: string | null = null
  private readonly records = new Map<number, WatcherProcessSubscriptionRecord>()
  private readonly pendingUnsubscribes = new Map<number, () => void>()
  private readonly cancelledSubscribesAwaitingChild = new Set<number>()

  constructor(private readonly options: WatcherProcessSupervisorOptions = {}) {}

  subscribe(
    dir: string,
    callback: WatcherProcessCallback,
    opts: WatcherProcessSubscribeOptions,
    hooks: WatcherProcessHooks = {}
  ): Promise<WatcherProcessSubscription> {
    return subscribeThroughWatcherSupervisor({
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
      killWatcherChildIfIdle: () => this.killWatcherChildIfIdle(),
      sendSubscribe: (child, record) => this.sendSubscribe(child, record),
      sendToChild: (child, message) => this.sendToChild(child, message),
      cancelPendingSubscribe: (record, error) => this.cancelPendingSubscribe(record, error)
    })
  }

  dispose(): void {
    this.shutdownRequested = true
    const proc = this.child
    this.child = null
    const error = watcherHostFailure('file watcher supervisor disposed', 'supervisor_disposed')
    disposeWatcherSupervisorSubscriptions(
      this.records,
      this.pendingUnsubscribes,
      this.cancelledSubscribesAwaitingChild,
      error
    )
    proc?.kill()
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
  }

  resetForTest(): void {
    this.dispose()
    this.shutdownRequested = false
    this.crashFuse.reset()
  }

  private ensureWatcherProcess(
    entryPath = this.options.entryPath ?? getWatcherProcessEntryPath()
  ): ChildProcess | null {
    if (this.shutdownRequested) {
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
    if (message.op === 'subscribe-started') {
      const record = this.records.get(message.id)
      if (record) {
        startPendingSubscribeTimeout(record, (error) => this.cancelPendingSubscribe(record, error))
        startInterruptedSubscribeTimeout(record, (error) =>
          this.cancelInterruptedSubscribe(record, error)
        )
      }
      return
    }
    if (message.op === 'cancel-requires-restart') {
      if (this.cancelledSubscribesAwaitingChild.delete(message.id)) {
        this.restartAfterCancelledSubscribe()
      }
      return
    }
    if (message.op === 'unsubscribed') {
      const completedCancellation = this.cancelledSubscribesAwaitingChild.delete(message.id)
      handleWatcherHostMessage(
        message,
        this.records,
        this.pendingUnsubscribes,
        reportWatcherTerminalError,
        () => this.killWatcherChildIfIdle()
      )
      if (completedCancellation) {
        this.killWatcherChildIfIdle()
      }
      return
    }
    handleWatcherHostMessage(
      message,
      this.records,
      this.pendingUnsubscribes,
      reportWatcherTerminalError,
      () => this.killWatcherChildIfIdle()
    )
  }

  private handleChildGone(
    proc: ChildProcess,
    code?: number | null,
    signal?: NodeJS.Signals | null
  ): void {
    if (this.child !== proc) {
      return
    }
    if (code !== undefined && (code !== 0 || signal)) {
      console.error(
        `[parcel-watcher-process] watcher process exited (code=${code}, signal=${signal})`
      )
    }
    this.child = null
    this.cancelledSubscribesAwaitingChild.clear()
    resolvePendingWatcherUnsubscribes(this.pendingUnsubscribes)
    if (this.shutdownRequested || this.records.size === 0) {
      return
    }
    this.crashFuse.recordCrash()
    for (const record of this.records.values()) {
      record.interrupted = true
      resetPendingSubscribeAttempt(record)
    }
    const replacement = this.ensureWatcherProcess()
    if (!replacement) {
      console.error(
        '[parcel-watcher-process] watcher process crashed repeatedly; disabling file watching'
      )
      failAllWatcherSubscriptions(
        this.records,
        watcherHostFailure('file watcher process crashed repeatedly', 'supervisor_crash_fuse')
      )
      this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
      return
    }
    console.error(
      `[parcel-watcher-process] watcher process crashed; resubscribing ${this.records.size} root(s)`
    )
    for (const record of this.records.values()) {
      this.sendSubscribe(replacement, record)
    }
  }

  private killWatcherChildIfIdle(): void {
    const proc = this.child
    if (!proc || this.records.size > 0) {
      return
    }
    this.child = null
    resolvePendingWatcherUnsubscribes(this.pendingUnsubscribes)
    proc.kill()
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
  }

  private cancelPendingSubscribe(
    record: WatcherProcessSubscriptionRecord,
    error: WatcherProcessFailure
  ): void {
    if (!record.pendingSubscribe || !this.records.delete(record.id)) {
      return
    }
    const crawlStarted = record.crawlStarted
    const pending = takePendingSubscribe(record)
    pending?.reject(error)
    if (crawlStarted) {
      this.restartAfterCancelledSubscribe()
      return
    }
    const proc = this.child
    if (!proc?.connected) {
      this.killWatcherChildIfIdle()
      return
    }
    this.cancelledSubscribesAwaitingChild.add(record.id)
    this.sendToChild(proc, { op: 'cancel-subscribe', id: record.id })
  }

  private cancelInterruptedSubscribe(
    record: WatcherProcessSubscriptionRecord,
    error: WatcherProcessFailure
  ): void {
    if (!record.interrupted || record.pendingSubscribe || !this.records.delete(record.id)) {
      return
    }
    resetPendingSubscribeAttempt(record)
    // Why: one slow recovery root must not pin every healthy root in its shard.
    // End that subscription so the runtime pool can retry it in quarantine.
    reportWatcherTerminalError(record, error)
    this.restartAfterCancelledSubscribe()
  }

  private restartAfterCancelledSubscribe(): void {
    const proc = this.child
    this.child = null
    this.cancelledSubscribesAwaitingChild.clear()
    resolvePendingWatcherUnsubscribes(this.pendingUnsubscribes)
    proc?.kill()
    if (this.records.size === 0) {
      this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
      return
    }
    const replacement = this.ensureWatcherProcess()
    if (!replacement) {
      failAllWatcherSubscriptions(
        this.records,
        watcherHostFailure(
          'file watcher process unavailable after subscription cancellation',
          'process_unavailable'
        )
      )
      this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
      return
    }
    for (const liveRecord of this.records.values()) {
      liveRecord.interrupted = true
      resetPendingSubscribeAttempt(liveRecord)
      this.sendSubscribe(replacement, liveRecord)
    }
  }

  private sendSubscribe(proc: ChildProcess, record: WatcherProcessSubscriptionRecord): void {
    resetPendingSubscribeAttempt(record)
    this.sendToChild(proc, {
      op: 'subscribe',
      id: record.id,
      dir: record.dir,
      opts: record.opts,
      delivery: record.hooks.delivery
    })
  }

  private sendToChild(proc: ChildProcess, message: HostToWatcherMessage): void {
    try {
      proc.send(message)
    } catch {
      // Channel already closed — the child's exit handler recovers.
    }
  }
}
