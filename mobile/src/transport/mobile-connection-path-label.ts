import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function mobileConnectionPathLabel(path: MobileConnectionPath): string {
  if (path === 'relay') {
    return 'MCode Relay'
  }
  return path === 'tailscale' ? 'Direct · Tailscale' : 'Direct · LAN'
}
