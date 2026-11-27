import type { EventEmitter } from 'node:events'
import type { ProviderReceiptReader } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
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

type RendererWatches = {
  pid: number
  document: AbortSignal
  primary?: ProcessExitWatch
  proof?: ProcessExitWatch
}

export class DesktopProviderReceiptWindow {
  transport = new AbortController()
  document?: ReceiptDocument
  private watches?: RendererWatches
  private stopTracking?: () => void

  constructor(
    sender: Pick<EventEmitter, 'once' | 'off'>,
    private readonly readers: ProviderReceiptReaders,
    forget: () => void
  ) {
    const destroyed = (): void => this.dispose()
    this.stopTracking = () => {
      sender.off('destroyed', destroyed)
      forget()
    }
    sender.once('destroyed', destroyed)
  }

  dispose(): void {
    this.document?.retire()
    this.stopTracking?.()
    this.stopTracking = undefined
    if (!this.readers.hasPostedReply(this.transport.signal)) {
      this.stopWatching()
    }
  }

  private rendererExited(): void {
    this.stopWatching()
    if (this.readers.hasPostedReply(this.transport.signal)) {
      this.document?.retire()
      this.transport.abort()
      this.transport = new AbortController()
    }
  }

  private stopWatching(): void {
    const watches = this.watches
    this.watches = undefined
    watches?.primary?.dispose()
    watches?.proof?.dispose()
  }

  private armWatch(
    watches: RendererWatches,
    slot: 'primary' | 'proof'
  ): ProcessExitWatch | undefined {
    const watch = watchProcessExit(
      watches.pid,
      (exited) => {
        if (this.watches !== watches || watches[slot] !== watch) {
          return
        }
        watches[slot] = undefined
        if (exited) {
          this.rendererExited()
        } else if (watches[slot === 'primary' ? 'proof' : 'primary']) {
          watches[slot] = this.armWatch(watches, slot)
        }
      },
      { requireProof: true }
    )
    return watch === 'gone' ? undefined : (watch ?? undefined)
  }

  watchRenderer(pid: number, document: AbortSignal): boolean {
    if (
      this.watches?.pid === pid &&
      this.watches.document === document &&
      this.watches.primary &&
      this.watches.proof
    ) {
      return true
    }
    if (this.readers.hasPostedReply(this.transport.signal)) {
      return false
    }
    // Separate kernel registrations pin the process instance before handoff and outlive the window.
    this.stopWatching()
    const watches: RendererWatches = { pid, document }
    this.watches = watches
    watches.primary = this.armWatch(watches, 'primary')
    watches.proof = watches.primary && this.armWatch(watches, 'proof')
    if (!watches.proof) {
      this.stopWatching()
      return false
    }
    return true
  }
}
