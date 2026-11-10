import {
  isPluginFrameOriginUrl,
  pluginFrameOrigin
} from '../../../shared/plugins/frames/plugin-frame-guest'

/**
 * Electron-free decisions for a plugin's guest session. The session, not CSP, is the network
 * boundary: anything that is not this plugin's own origin or an in-memory URL is cancelled.
 */

/** `webRequest.onBeforeRequest`: only the plugin's origin, `data:`, `blob:` and `devtools:`. */
export function isAllowedPluginFrameRequestUrl(url: string, frameKey: string): boolean {
  return (
    url.startsWith(`${pluginFrameOrigin(frameKey)}/`) ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('devtools:')
  )
}

/** Top-level documents stay on the plugin's origin; subframes may also be inert `about:` documents. */
export function isAllowedPluginFrameNavigation(
  url: string,
  frameKey: string,
  isMainFrame: boolean
): boolean {
  if (isPluginFrameOriginUrl(url, frameKey)) {
    return true
  }
  return !isMainFrame && (url === 'about:blank' || url === 'about:srcdoc')
}

/** Webview admission: the partition's key must be the key of the origin the guest loads. */
export function pluginFrameAttachKey(partitionKey: string | null, src: string): string | null {
  return partitionKey !== null && isPluginFrameOriginUrl(src, partitionKey) ? partitionKey : null
}
