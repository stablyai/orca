import { useSyncExternalStore } from 'react'
import { readBridgeExternalLinkUrl } from '../mobile-web-shell/bridge/bridge-caps'
import {
  canBridgeOpenExternalLink,
  type BridgeExternalLinkSupport
} from '../mobile-web-shell/bridge/bridge-external-link-support'

type ExternalLinkOpener = (url: string) => boolean
type SupportSource = {
  read: () => BridgeExternalLinkSupport
  subscribe: (listener: () => void) => () => void
}
const legacy: BridgeExternalLinkSupport = {
  granted: true,
  complete: false,
  inboundMessageBytes: 655360
}
let post: ExternalLinkOpener = () => false
let source: SupportSource = {
  read: () => ({ ...legacy, granted: false }),
  subscribe: () => () => {}
}

export function publishExternalLinkOpener(
  opener: ExternalLinkOpener,
  support: SupportSource = { read: () => legacy, subscribe: () => () => {} }
): void {
  post = opener
  source = support
}
export function canOpenExternalLink(url: string): boolean {
  return canBridgeOpenExternalLink(url, source.read())
}
export function useExternalLinkAvailable(url: string | undefined): boolean {
  return useSyncExternalStore(source.subscribe, () => url !== undefined && canOpenExternalLink(url))
}
export function openExternalLink(url: string): void {
  const support = source.read()
  if (readBridgeExternalLinkUrl(url, support.complete) === null) {
    console.warn('[page] refused to open a URL outside the allowed schemes', { url })
    return
  }
  if (!canBridgeOpenExternalLink(url, support) || !post(url)) {
    console.warn('[page] the shell did not take a URL to open', { url })
  }
}
