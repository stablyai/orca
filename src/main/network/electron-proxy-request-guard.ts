import type { Session } from 'electron'
import { getProxySessionApplicationReadiness } from './proxy-settings'
import { isAllowedChatPreviewRequest } from '../media/chat-address-preview-grants'

/** Hold default-session requests until the newest app-wide proxy transition settles. */
export function installElectronProxyRequestGuard(proxySession: Session): void {
  proxySession.webRequest.onBeforeRequest((details, callback) => {
    const readiness = getProxySessionApplicationReadiness(proxySession)
    const answer = (ready: boolean): void =>
      callback(ready && isAllowedChatPreviewRequest(details) ? {} : { cancel: true })
    if (typeof readiness === 'boolean') {
      answer(readiness)
    } else {
      void readiness.then(answer)
    }
  })
}
