import { translate } from '../i18n/mobile-i18n'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

/** Labels the selected transport without conflating native iroh with Orca Relay. */
export function mobileConnectionPathLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  if (path === 'iroh') {
    return 'Iroh'
  }
  return path === 'tailscale'
    ? translate('connection.connectionPathLabel.directTailscale', 'Direct · Tailscale')
    : translate('connection.connectionPathLabel.directLan', 'Direct · LAN')
}

/** Uses spoken "via" wording for direct paths instead of the compact visual separator. */
export function mobileConnectionPathAccessibilityLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  if (path === 'iroh') {
    return 'Iroh'
  }
  return path === 'tailscale'
    ? translate('connection.connectionPathLabel.directViaTailscale', 'Direct via Tailscale')
    : translate('connection.connectionPathLabel.directViaLan', 'Direct via LAN')
}
