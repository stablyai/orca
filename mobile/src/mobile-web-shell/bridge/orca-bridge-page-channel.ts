import type { BridgeRpcClientOptions } from './bridge-rpc-client'

/**
 * The page's half of the native channel, as the document-start installer leaves it.
 *
 * `postMessage` and an `onmessage` assignment are the whole surface, and it is deliberately the
 * intersection of the two platforms: Android's `addWebMessageListener` injects an object of this
 * shape, and `MobileWebShellView.swift` installs one to match. Nothing else about the WebView is
 * addressable from the page.
 */
export type OrcaBridgePageChannel = {
  postMessage: (json: string) => void
  onmessage: ((event: { data: string }) => void) | null
}

/**
 * `null` for a page that is not inside the shell — a browser, or a WebView mounted with the bridge
 * off. That is a supported way to open the bundle, so the caller substitutes rather than throws.
 */
export function readOrcaBridgePageChannel(): OrcaBridgePageChannel | null {
  const scope: typeof globalThis & { orcaBridge?: OrcaBridgePageChannel } = globalThis
  const channel = scope.orcaBridge
  if (channel === undefined || typeof channel.postMessage !== 'function') {
    return null
  }
  return channel
}

/**
 * The channel as the page client's transport.
 *
 * One `onmessage` slot exists, so one client reads the channel; a second would silently take the
 * first one's frames. The page holds exactly one client, which is what makes that safe.
 */
export function createOrcaBridgePageTransport(
  channel: OrcaBridgePageChannel
): Pick<BridgeRpcClientOptions, 'send' | 'onMessage'> {
  return {
    send: (json) => {
      channel.postMessage(json)
    },
    onMessage: (handler) => {
      channel.onmessage = (event) => {
        handler(event.data)
      }
      return () => {
        channel.onmessage = null
      }
    }
  }
}
