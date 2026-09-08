import type { MobileWebBridgeErrorCode } from '../../shared/mobile-web/bridge-contract'

export class MobileWebBridgeClientError extends Error {
  constructor(
    readonly code: MobileWebBridgeErrorCode,
    readonly retryable: boolean
  ) {
    super(code)
  }
}
