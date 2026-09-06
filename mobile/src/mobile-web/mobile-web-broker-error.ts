import type { MobileWebBridgeErrorCode } from '../../../src/shared/mobile-web/bridge-contract'

export class MobileWebBrokerError extends Error {
  constructor(readonly code: MobileWebBridgeErrorCode) {
    super(code)
  }
}

export function mobileWebBridgeErrorCode(error: unknown): MobileWebBridgeErrorCode {
  if (error instanceof MobileWebBrokerError) {
    return error.code
  }
  return error instanceof Error && error.name === 'ZodError' ? 'invalid_request' : 'host_error'
}

export function isRetryableMobileWebBridgeError(code: MobileWebBridgeErrorCode): boolean {
  return code === 'not_connected' || code === 'timeout' || code === 'host_error'
}

/**
 * A host RPC failure the page can act on. `host_error` is retryable, so collapsing every failure
 * into it made "this host will never answer this call" indistinguishable from a blip: the page's
 * cached package can outlive or predate the desktop release it is driving, and a method that host
 * does not have answers `method_not_found` forever. `forbidden` is the mobile allowlist refusing
 * the method, which is the same structural absence; the bridge has no `forbidden` code, and
 * `unsupported_capability` is the one the page already handles for an operation it cannot reach.
 */
export function mobileWebBrokerHostRpcError(error: { code?: unknown }): MobileWebBrokerError {
  return new MobileWebBrokerError(mobileWebBridgeErrorCodeForHostRpc(error))
}

export function mobileWebBridgeErrorCodeForHostRpc(error: {
  code?: unknown
}): MobileWebBridgeErrorCode {
  switch (typeof error.code === 'string' ? error.code : '') {
    case 'method_not_found':
    case 'method_not_supported':
    case 'forbidden':
      return 'unsupported_capability'
    default:
      return 'host_error'
  }
}
