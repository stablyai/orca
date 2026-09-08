import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { secureMobileWebBridgeRequestId } from './mobile-web-bridge-request-encoding'

export function uniqueMobileWebMessageId(
  create: (() => string) | undefined,
  isUsed: (id: string) => boolean,
  excluded?: string
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const requestId = create?.() ?? secureMobileWebBridgeRequestId()
    if (requestId !== excluded && !isUsed(requestId)) {
      return requestId
    }
  }
  throw new MobileWebBridgeClientError('conflict', true)
}
