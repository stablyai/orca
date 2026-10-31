import { isBridgeFrameWithinCap, readBridgeExternalLinkUrl } from './bridge-caps'
import { BRIDGE_EXTERNAL_LINK_FULL_URL, BRIDGE_EXTERNAL_LINK_GRANT } from './bridge-frame-fields'
import type { BridgeGrants } from './bridge-envelope'

export type BridgeExternalLinkSupport = {
  granted: boolean
  complete: boolean
  inboundMessageBytes: number
}
export const NO_EXTERNAL_LINK_SUPPORT: BridgeExternalLinkSupport = {
  granted: false,
  complete: false,
  inboundMessageBytes: 0
}
export function readBridgeExternalLinkSupport(
  session: {
    grants: BridgeGrants
    inboundMessageBytes?: number
  } | null
): BridgeExternalLinkSupport {
  return session === null
    ? NO_EXTERNAL_LINK_SUPPORT
    : {
        granted: session.grants.native.includes(BRIDGE_EXTERNAL_LINK_GRANT),
        complete: session.grants.native.includes(BRIDGE_EXTERNAL_LINK_FULL_URL),
        inboundMessageBytes: session.inboundMessageBytes ?? 655360
      }
}
export function sameBridgeExternalLinkSupport(
  a: BridgeExternalLinkSupport,
  b: BridgeExternalLinkSupport
): boolean {
  return (
    a.granted === b.granted &&
    a.complete === b.complete &&
    a.inboundMessageBytes === b.inboundMessageBytes
  )
}
export function canBridgeOpenExternalLink(
  url: string,
  support: BridgeExternalLinkSupport
): boolean {
  if (!support.granted) {
    return false
  }
  const target = readBridgeExternalLinkUrl(url, support.complete)
  return (
    target !== null &&
    isBridgeFrameWithinCap(
      JSON.stringify({ v: 1, type: 'notify', name: BRIDGE_EXTERNAL_LINK_GRANT, url: target }),
      support.inboundMessageBytes
    )
  )
}

export function refreshBridgeExternalLinkGrants(
  held: BridgeGrants,
  sent: BridgeGrants
): BridgeGrants {
  const selected = (grant: string) =>
    grant === BRIDGE_EXTERNAL_LINK_GRANT || grant === BRIDGE_EXTERNAL_LINK_FULL_URL
  return {
    ...held,
    native: [...held.native.filter((grant) => !selected(grant)), ...sent.native.filter(selected)]
  }
}
