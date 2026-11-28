// The Orca installations this phone is paired with directly, from each host's own status on every
// connect. A page hides a desktop's relayed copy of one of these, so the phone uses one route per
// server. A pairing the host refused stops counting, so its relayed copy shows again.
const installationByHost = new Map<string, string>()
const refusedHosts = new Set<string>()
const offLanHosts = new Set<string>()

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

/** Whether the host's pairing reaches it off its own network: through Orca Relay or Tailscale. */
export function setHostReachesOffLan(hostId: string, reaches: boolean): void {
  if (offLanHosts.has(hostId) !== reaches) {
    if (reaches) {
      offLanHosts.add(hostId)
    } else {
      offLanHosts.delete(hostId)
    }
  }
}

export function forgetHostInstallation(hostId: string): void {
  installationByHost.delete(hostId)
  refusedHosts.delete(hostId)
  offLanHosts.delete(hostId)
}

/** Direct pairings that reach their server at least as far as `viaHostId` (the relaying desktop)
 *  does: a LAN-only pairing never hides a copy the desktop relays off the LAN. */
export function directPairingInstallationIds(viaHostId: string | null): string[] {
  const viaOffLan = viaHostId !== null && offLanHosts.has(viaHostId)
  return [
    ...new Set(
      [...installationByHost].flatMap(([hostId, id]) =>
        refusedHosts.has(hostId) || (viaOffLan && !offLanHosts.has(hostId)) ? [] : [id]
      )
    )
  ]
}
