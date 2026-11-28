// The Orca installations this phone is paired with directly, from each host's own status on every
// connect. A page hides a desktop's relayed copy of one of these, so the phone uses one route per
// server. A pairing the host refused stops counting, so its relayed copy shows again.
const installationByHost = new Map<string, string>()
const refusedHosts = new Set<string>()
const relayRoutedHosts = new Set<string>()

export function recordHostInstallation(hostId: string, installationId: string | null): void {
  if (installationId) {
    installationByHost.set(hostId, installationId)
  } else {
    installationByHost.delete(hostId)
  }
}

export function setHostPairingRefused(hostId: string, refused: boolean): void {
  if (refusedHosts.has(hostId) !== refused) {
    if (refused) {
      refusedHosts.add(hostId)
    } else {
      refusedHosts.delete(hostId)
    }
  }
}

/** Whether the host's pairing reaches it through Orca Relay too, not only on its network. */
export function setHostRelayRouted(hostId: string, routed: boolean): void {
  if (relayRoutedHosts.has(hostId) !== routed) {
    if (routed) {
      relayRoutedHosts.add(hostId)
    } else {
      relayRoutedHosts.delete(hostId)
    }
  }
}

export function forgetHostInstallation(hostId: string): void {
  installationByHost.delete(hostId)
  refusedHosts.delete(hostId)
  relayRoutedHosts.delete(hostId)
}

/** Direct pairings that reach their server at least as far as `viaHostId` (the relaying desktop)
 *  does: a LAN-only pairing never hides a copy the desktop relays off the LAN. */
export function directPairingInstallationIds(viaHostId: string | null): string[] {
  const viaRelay = viaHostId !== null && relayRoutedHosts.has(viaHostId)
  return [
    ...new Set(
      [...installationByHost].flatMap(([hostId, id]) =>
        refusedHosts.has(hostId) || (viaRelay && !relayRoutedHosts.has(hostId)) ? [] : [id]
      )
    )
  ]
}
