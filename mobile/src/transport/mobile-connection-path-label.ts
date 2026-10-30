import { translate } from '../i18n/mobile-i18n'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function mobileConnectionPathLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  return path === 'tailscale'
    ? translate('connection.connectionPathLabel.directTailscale', 'Direct · Tailscale')
    : translate('connection.connectionPathLabel.directLan', 'Direct · LAN')
}

export function mobileConnectionPathAccessibilityLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  return path === 'tailscale'
    ? translate('connection.connectionPathLabel.directViaTailscale', 'Direct via Tailscale')
    : translate('connection.connectionPathLabel.directViaLan', 'Direct via LAN')
}
