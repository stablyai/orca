import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'

const NATIVE_CHAT_SEND_OPERATION = 'nativeChat.sendMessage'

export class MobileWebOneShotResponseDrop {
  private requestId: string | null = null
  private dropped = false
  private readonly enabled: boolean

  constructor(operationKey: string | undefined) {
    this.enabled = operationKey === NATIVE_CHAT_SEND_OPERATION
  }

  recordRequest(message: MobileWebBridgePageMessage): void {
    if (
      !this.enabled ||
      this.dropped ||
      this.requestId ||
      message.type !== 'request' ||
      message.mode !== 'once' ||
      `${message.capability}.${message.operation}` !== NATIVE_CHAT_SEND_OPERATION
    ) {
      return
    }
    this.requestId = message.requestId
  }

  shouldDrop(message: MobileWebBridgeShellMessage): boolean {
    if (
      !this.enabled ||
      this.dropped ||
      message.type !== 'response' ||
      message.requestId !== this.requestId
    ) {
      return false
    }
    this.requestId = null
    this.dropped = true
    return true
  }
}
