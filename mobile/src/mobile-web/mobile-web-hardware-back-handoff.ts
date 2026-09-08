import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'

const HARDWARE_BACK_RESULT_TIMEOUT_MS = 750

type CapabilityMessage = Extract<MobileWebBridgePageMessage, { type: 'hardwareBackCapability' }>
type ResultMessage = Extract<MobileWebBridgePageMessage, { type: 'hardwareBackResult' }>
type RequestMessage = Extract<MobileWebBridgeShellMessage, { type: 'hardwareBack' }>

type PendingBack = {
  timeout: ReturnType<typeof setTimeout>
  onUnhandled: () => void
}

export class MobileWebHardwareBackHandoff {
  private context: MobileWebBridgeMessageContext | null = null
  private pageReady = false
  private supported = false
  private sequence = 0
  private readonly pending = new Map<number, PendingBack>()

  constructor(private readonly timeoutMs = HARDWARE_BACK_RESULT_TIMEOUT_MS) {}

  setContext(context: MobileWebBridgeMessageContext | null): void {
    if (sameContext(this.context, context)) {
      return
    }
    this.clearPending()
    this.context = context
    this.pageReady = false
    this.supported = false
  }

  resetPage(): void {
    this.clearPending()
    this.pageReady = false
    this.supported = false
  }

  acknowledgeReady(context: MobileWebBridgeMessageContext): void {
    if (!sameContext(this.context, context)) {
      return
    }
    this.clearPending()
    this.pageReady = true
    this.supported = false
  }

  declareSupport(message: CapabilityMessage): void {
    if (this.pageReady && sameContext(this.context, message)) {
      this.supported = true
    }
  }

  request(
    postMessage: (message: RequestMessage) => Promise<void>,
    onUnhandled: () => void
  ): boolean {
    if (!this.context || !this.pageReady || !this.supported) {
      return false
    }
    this.sequence = this.sequence === Number.MAX_SAFE_INTEGER ? 0 : this.sequence + 1
    const sequence = this.sequence
    const message: RequestMessage = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      ...this.context,
      type: 'hardwareBack',
      sequence
    }
    this.pending.set(sequence, {
      timeout: setTimeout(() => this.complete(sequence, false), this.timeoutMs),
      onUnhandled
    })
    try {
      void postMessage(message).catch(() => this.complete(sequence, false))
    } catch {
      this.complete(sequence, false)
    }
    return true
  }

  resolve(message: ResultMessage): boolean {
    if (!sameContext(this.context, message) || !this.pending.has(message.sequence)) {
      return false
    }
    this.complete(message.sequence, message.handled)
    return true
  }

  handlePageMessage(message: MobileWebBridgePageMessage): boolean {
    if (message.type === 'ready') {
      this.acknowledgeReady(message)
      return false
    }
    if (message.type === 'hardwareBackCapability') {
      this.declareSupport(message)
      return true
    }
    if (message.type === 'hardwareBackResult') {
      this.resolve(message)
      return true
    }
    return false
  }

  cancelPending(): void {
    this.clearPending()
  }

  clear(): void {
    this.clearPending()
    this.context = null
    this.pageReady = false
    this.supported = false
  }

  private complete(sequence: number, handled: boolean): void {
    const pending = this.pending.get(sequence)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeout)
    this.pending.delete(sequence)
    if (!handled) {
      pending.onUnhandled()
    }
  }

  private clearPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
    }
    this.pending.clear()
  }
}

function sameContext(
  left: MobileWebBridgeMessageContext | null,
  right: MobileWebBridgeMessageContext | null
): boolean {
  return (
    left?.shellSessionId === right?.shellSessionId &&
    left?.buildId === right?.buildId &&
    Boolean(left) === Boolean(right)
  )
}
