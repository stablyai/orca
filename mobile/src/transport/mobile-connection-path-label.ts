import type { MobileConnectionPath } from './stable-logical-rpc-client'
import { t } from '@/i18n/mobile-i18n'

export function mobileConnectionPathLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return t('mobileConnectionPathLabel.orca')
  }
  return path === 'tailscale'
    ? t('mobileConnectionPathLabel.directTailscale')
    : t('mobileConnectionPathLabel.directLan')
}
