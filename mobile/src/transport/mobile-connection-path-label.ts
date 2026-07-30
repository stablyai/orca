import type { MobileConnectionPath } from './stable-logical-rpc-client'
import { t } from '@/i18n/mobile-i18n'

export function mobileConnectionPathLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return t('m.Lo_8ioI')
  }
  return path === 'tailscale' ? t('m.f3Si3vU') : t('m.hPnnpWc')
}
