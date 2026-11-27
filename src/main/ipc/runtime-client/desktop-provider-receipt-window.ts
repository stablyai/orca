import type { WebContents } from 'electron'
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
  binding?: { reader: ProviderReceiptReader; pending: boolean; close: () => void }
  retire: () => void
}

export class DesktopProviderReceiptWindow {
  transport = new AbortController()
  document?: ReceiptDocument
  private postedToPid?: number
  private exitWatch?: ProcessExitWatch
  private stopTracking?: () => void

  constructor(
    sender: WebContents,
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
      this.exitWatch?.dispose()
      this.exitWatch = undefined
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
    this.exitWatch?.dispose()
    this.exitWatch = undefined
    this.postedToPid = undefined
    if (this.readers.hasPostedReply(this.transport.signal)) {
      this.document?.retire()
      this.transport.abort()
      this.transport = new AbortController()
    }
  }

  watchRenderer(pid: number): boolean {
    if (this.postedToPid === pid && this.exitWatch) {
      return true
    }
    this.exitWatch?.dispose()
    this.exitWatch = undefined
    // Pin the process before posting. The watch outlives a closed WebContents with unread credit.
    const watch = watchProcessExit(pid, (exited) => {
      if (exited) {
        this.rendererExited(pid)
      } else if (this.postedToPid === pid) {
        this.exitWatch = undefined
        this.collectExitedRenderer()
      }
    })
    if (!watch || watch === 'gone') {
      return false
    }
    this.postedToPid = pid
    this.exitWatch = watch
    return true
  }
}
