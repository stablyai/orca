import type { MobileWebBridgeClient } from './mobile-web-bridge-client'
import type { MobileWebPagePreferencesPayload } from '../../shared/mobile-web/page-preferences-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

let active: MobileWebBridgeClient | null = null
export function setMobileWebPagePreferencesClient(client: MobileWebBridgeClient | null): void {
  active = client
}
export async function requestMobileWebPagePreferences(payload: MobileWebPagePreferencesPayload) {
  const client = active
  if (!client) {
    throw new MobileWebBridgeClientError('unavailable', true)
  }
  const result = await client.native.pagePreferences(payload)
  if (active !== client) {
    throw new MobileWebBridgeClientError('cancelled', false)
  }
  return result
}
