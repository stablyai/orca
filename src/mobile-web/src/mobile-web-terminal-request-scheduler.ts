import type {
  MobileWebTerminalDeviceInputResult,
  MobileWebTerminalRequest
} from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebBridgeClient } from './mobile-web-bridge-client'

type InputOperation = 'input' | 'queryReply'
type Viewport = { cols: number; rows: number }
type DeviceInputOperation = Extract<
  MobileWebTerminalRequest,
  { operation: 'clipboardPaste' | 'attachImage' }
>
type OrdinaryTerminalRequest = Exclude<
  MobileWebTerminalRequest,
  { operation: 'subscribe' } | DeviceInputOperation
>

export class MobileWebTerminalRequestScheduler {
  private bridgeReady = false
  private hostReady = false
  private disposed = false
  private queryReplyNegotiated = false
  private inputSequence = 0
  private inputTail = Promise.resolve()
  private pendingAck: number | null = null
  private ackSending = false
  private pendingResize: Viewport | null = null
  private resizeSending = false
  private pendingVisibility: boolean | null = null
  private visibilitySending = false
  private resyncPending = false

  constructor(
    private readonly client: MobileWebBridgeClient,
    private readonly streamId: string,
    private readonly onError: () => void
  ) {}

  markBridgeReady(): void {
    if (this.disposed) {
      return
    }
    this.bridgeReady = true
    this.drainVisibility()
  }

  markHostReady(queryReplyNegotiated: boolean): void {
    if (this.disposed) {
      return
    }
    this.hostReady = true
    this.resyncPending = false
    this.queryReplyNegotiated = queryReplyNegotiated
    this.drainResize()
    this.drainAck()
  }

  sendInput(operation: InputOperation, data: string): void {
    void this.sendInputAsync(operation, data)
  }

  sendInputAsync(operation: InputOperation, data: string): Promise<boolean> {
    if (this.disposed || !this.canSendInput(operation)) {
      return Promise.resolve(false)
    }
    const result = this.inputTail
      .then(async () => {
        if (this.disposed || !this.canSendInput(operation)) {
          return false
        }
        await this.client.terminalRequest({
          operation,
          streamId: this.streamId,
          sequence: this.inputSequence,
          data
        })
        this.inputSequence += 1
        return true
      })
      .catch(() => {
        this.reportError()
        return false
      })
    this.inputTail = result.then(() => undefined)
    return result
  }

  pasteClipboard(bracketedPaste: boolean): Promise<MobileWebTerminalDeviceInputResult | null> {
    return this.sendDeviceInput({
      operation: 'clipboardPaste',
      streamId: this.streamId,
      sequence: this.inputSequence,
      bracketedPaste
    })
  }

  attachImage(source: 'library' | 'files'): Promise<MobileWebTerminalDeviceInputResult | null> {
    return this.sendDeviceInput({
      operation: 'attachImage',
      streamId: this.streamId,
      sequence: this.inputSequence,
      source
    })
  }

  acknowledge(throughSequence: number): void {
    if (this.disposed) {
      return
    }
    this.pendingAck = Math.max(this.pendingAck ?? 0, throughSequence)
    this.drainAck()
  }

  resize(viewport: Viewport): void {
    if (this.disposed) {
      return
    }
    this.pendingResize = viewport
    this.drainResize()
  }

  setVisible(visible: boolean): void {
    if (this.disposed) {
      return
    }
    if (!visible) {
      this.hostReady = false
      this.queryReplyNegotiated = false
      this.pendingAck = null
      this.resyncPending = false
    }
    this.pendingVisibility = visible
    this.drainVisibility()
  }

  setDisplayMode(mode: 'auto' | 'desktop', viewport: Viewport | null): Promise<boolean> {
    return this.runAction({
      operation: 'displayMode',
      streamId: this.streamId,
      mode,
      ...(viewport && mode === 'auto' ? { viewport } : {})
    })
  }

  clear(): Promise<boolean> {
    return this.runAction({ operation: 'clear', streamId: this.streamId })
  }

  rename(title: string): Promise<boolean> {
    return this.runAction({ operation: 'rename', streamId: this.streamId, title })
  }

  requestResync(fromSequence: number, reason: 'gap' | 'overflow'): void {
    if (this.disposed || !this.hostReady || this.resyncPending) {
      return
    }
    this.resyncPending = true
    void this.request({
      operation: 'resync',
      streamId: this.streamId,
      fromSequence,
      reason
    }).catch(() => {
      this.resyncPending = false
      this.reportError()
    })
  }

  markResynced(): void {
    this.resyncPending = false
  }

  dispose(): void {
    this.disposed = true
    this.pendingAck = null
    this.pendingResize = null
    this.pendingVisibility = null
  }

  private canSendInput(operation: InputOperation): boolean {
    return this.hostReady && (operation !== 'queryReply' || this.queryReplyNegotiated)
  }

  private drainAck(): void {
    if (this.disposed || !this.hostReady || this.ackSending || this.pendingAck === null) {
      return
    }
    const throughSequence = this.pendingAck
    this.pendingAck = null
    this.ackSending = true
    void this.request({
      operation: 'ack',
      streamId: this.streamId,
      throughSequence
    })
      .catch(() => this.reportError())
      .finally(() => {
        this.ackSending = false
        this.drainAck()
      })
  }

  private drainResize(): void {
    if (this.disposed || !this.hostReady || this.resizeSending || !this.pendingResize) {
      return
    }
    const viewport = this.pendingResize
    this.pendingResize = null
    this.resizeSending = true
    void this.request({ operation: 'resize', streamId: this.streamId, viewport })
      .catch(() => this.reportError())
      .finally(() => {
        this.resizeSending = false
        this.drainResize()
      })
  }

  private drainVisibility(): void {
    if (
      this.disposed ||
      !this.bridgeReady ||
      this.visibilitySending ||
      this.pendingVisibility === null
    ) {
      return
    }
    const visible = this.pendingVisibility
    this.pendingVisibility = null
    this.visibilitySending = true
    void this.request({ operation: 'visibility', streamId: this.streamId, visible })
      .catch(() => this.reportError())
      .finally(() => {
        this.visibilitySending = false
        this.drainVisibility()
      })
  }

  private request(payload: OrdinaryTerminalRequest): Promise<null> {
    return this.client.terminalRequest(payload)
  }

  private async runAction(payload: OrdinaryTerminalRequest): Promise<boolean> {
    if (this.disposed || !this.bridgeReady) {
      return false
    }
    try {
      await this.request(payload)
      return true
    } catch {
      this.reportError()
      return false
    }
  }

  private sendDeviceInput(
    payload: DeviceInputOperation
  ): Promise<MobileWebTerminalDeviceInputResult | null> {
    if (this.disposed || !this.canSendInput('input')) {
      return Promise.resolve(null)
    }
    const result = this.inputTail
      .then(async () => {
        if (this.disposed || !this.canSendInput('input')) {
          return null
        }
        const sequencedPayload = { ...payload, sequence: this.inputSequence }
        const response = await this.client.terminalDeviceInputRequest(sequencedPayload)
        this.inputSequence += 1
        return response
      })
      .catch(() => {
        this.reportError()
        return null
      })
    this.inputTail = result.then(() => undefined)
    return result
  }

  private reportError(): void {
    if (!this.disposed) {
      this.onError()
    }
  }
}
