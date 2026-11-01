import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeNodeDistMirrorUrl } from '../../shared/node-dist-mirror'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../shared/network-proxy'

/** Network fields as they may be stored: an invalid URL is saved as empty, never as typed. */
export function sanitizeNetworkSettings(
  args: Partial<GlobalSettings>,
  sanitized: Partial<GlobalSettings>
): void {
  if ('httpProxyUrl' in args) {
    const proxyUrl = normalizeProxyUrl(args.httpProxyUrl)
    sanitized.httpProxyUrl = proxyUrl.ok ? proxyUrl.value : ''
  }
  if ('httpProxyBypassRules' in args) {
    sanitized.httpProxyBypassRules = normalizeProxyBypassRules(args.httpProxyBypassRules)
  }
  if ('nodeDistMirrorUrl' in args) {
    sanitized.nodeDistMirrorUrl = normalizeNodeDistMirrorUrl(args.nodeDistMirrorUrl).value
  }
}
