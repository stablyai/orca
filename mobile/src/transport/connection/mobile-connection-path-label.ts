import type { Translate } from '../../i18n/mobile-i18n'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function mobileConnectionPathLabel(path: MobileConnectionPath, t: Translate): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  return path === 'tailscale'
    ? t('connection.connectionPathLabel.directTailscale', 'Direct · Tailscale')
    : t('connection.connectionPathLabel.directLan', 'Direct · LAN')
}

export function mobileConnectionPathAccessibilityLabel(
  path: MobileConnectionPath,
  t: Translate
): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  return path === 'tailscale'
    ? t('connection.connectionPathLabel.directViaTailscale', 'Direct via Tailscale')
    : t('connection.connectionPathLabel.directViaLan', 'Direct via LAN')
}
