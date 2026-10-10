// Why: the mobile.* RPC handlers resolve the pairing surface through this accessor set; building it
// here keeps orcad-entry under the file-length ratchet while keeping every delegate explicit.
import {
  getDefaultPairingAddress,
  getPairingNetworkInterfaces
} from '../runtime/pairing-network-interfaces'
import { encodeMobilePairingQr } from '../runtime/mobile-pairing-qr'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { MobilePairingRpcAccessors } from '../runtime/rpc/methods/mobile-pairing'

export function buildOrcadMobilePairingAccessors(
  rpc: OrcaRuntimeRpcServer
): MobilePairingRpcAccessors {
  return {
    getWebSocketEndpoint: () => rpc.getWebSocketEndpoint(),
    // Why: the pairing helper omits `family`; the mobile wire contract requires it.
    getPairingNetworkInterfaces: async () =>
      (await getPairingNetworkInterfaces()).map(({ name, address }) => ({
        name,
        address,
        family: address.includes(':') ? ('IPv6' as const) : ('IPv4' as const)
      })),
    getDefaultPairingAddress: () => getDefaultPairingAddress(),
    createMobilePairingOffer: (args) => rpc.createMobilePairingOffer(args),
    createPairingOffer: (args) => rpc.createPairingOffer(args),
    ensureNetworkExposure: () => rpc.ensureNetworkExposure(),
    getDeviceRegistry: () => rpc.getDeviceRegistry(),
    revokeMobileDevice: (deviceId) => rpc.revokeMobileDevice(deviceId),
    // Why: headless never attaches the desktop relay; 'automatic' fails closed with relay_mint_failed (use local-only).
    isDesktopRelayProviderAttached: () => false,
    encodePairingQr: (pairingUrl) => encodeMobilePairingQr(pairingUrl)
  }
}
