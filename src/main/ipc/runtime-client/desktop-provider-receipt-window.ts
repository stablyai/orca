import type { EventEmitter } from 'node:events'
import type { ProviderReceiptReader } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { inspectProcessSignal } from '../../daemon/endpoint/identity/daemon-process-inspection'
import type { ProviderReceiptDestination } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-credits'
import type { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import {
  watchProcessExit,
  type ProcessExitWatch
} from '../../pty/process-retirement/native-process-exit-watch'

export type ReceiptDocument = {
  endpoint: ProviderReceiptDestination
  isCurrent: () => boolean
  isFrameCurrent: () => boolean
  binding?: { reader: ProviderReceiptReader; pending: boolean; close: () => void }
  retire: () => void
}

export class DesktopProviderReceiptWindow {
  transport = new AbortController()
  document?: ReceiptDocument
  private postedToPid?: number
  private exitWatch?: ProcessExitWatch
  private retry?: NodeJS.Timeout
  private stopTracking?: () => void

  constructor(
    sender: Pick<EventEmitter, 'on' | 'once' | 'off'>,
    private readonly readers: ProviderReceiptReaders,
    forget: () => void
  ) {
    const rendererGone = (): void => this.collectExitedRenderer()
    const destroyed = (): void => this.dispose()
    this.stopTracking = () => {
      sender.off('render-process-gone', rendererGone)
      sender.off('destroyed', destroyed)
      forget()
    }
    sender.on('render-process-gone', rendererGone)
    sender.once('destroyed', destroyed)
  }

  dispose(): void {
    this.document?.retire()
    this.collectExitedRenderer()
    this.stopTracking?.()
    this.stopTracking = undefined
    if (!this.readers.hasPostedReply(this.transport.signal)) {
      this.stopWatching()
    }
  }

  observeRenderer(pid: number): void {
    if (this.postedToPid !== pid) {
      this.collectExitedRenderer()
    }
  }

  private collectExitedRenderer(): void {
    const pid = this.postedToPid
    if (pid !== undefined && inspectProcessSignal(pid) === 'missing') {
      this.rendererExited(pid)
    }
  }

  private rendererExited(pid: number): void {
    if (this.postedToPid !== pid) {
      return
    }
    this.stopWatching()
    if (this.readers.hasPostedReply(this.transport.signal)) {
      this.document?.retire()
      this.transport.abort()
      this.transport = new AbortController()
    }
  }

  private stopWatching(): void {
    this.exitWatch?.dispose()
    this.exitWatch = undefined
    clearTimeout(this.retry)
    this.retry = undefined
    this.postedToPid = undefined
  }

  private recoverWatch(pid: number): void {
    if (!this.readers.hasPostedReply(this.transport.signal)) {
      this.stopWatching()
      return
    }
    if (inspectProcessSignal(pid) === 'missing' || this.armWatch(pid) === 'gone') {
      this.rendererExited(pid)
    } else if (!this.exitWatch) {
      // Only a still-charged renderer can keep one unref'd retry after WebContents destruction.
      this.retry = setTimeout(() => {
        this.retry = undefined
        this.recoverWatch(pid)
      }, 1000).unref()
    }
  }

  private armWatch(pid: number): ProcessExitWatch | 'gone' | null {
    const watch = watchProcessExit(
      pid,
      (exited) => {
        if (this.exitWatch !== watch) {
          return
        }
        if (exited) {
          this.rendererExited(pid)
        } else {
          this.exitWatch = undefined
          this.recoverWatch(pid)
        }
      },
      { requireProof: true }
    )
    if (watch && watch !== 'gone') {
      this.postedToPid = pid
      this.exitWatch = watch
    }
    return watch
  }

  watchRenderer(pid: number): boolean {
    if (this.postedToPid === pid && this.exitWatch) {
      return true
    }
    if (this.readers.hasPostedReply(this.transport.signal)) {
      return false
    }
    // Pin the process before posting. The watch outlives a closed WebContents with unread credit.
    this.stopWatching()
    this.armWatch(pid)
    return this.exitWatch !== undefined
  }
}
