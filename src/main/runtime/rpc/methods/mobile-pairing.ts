// Why: phone-scope callers receive `forbidden` automatically via the dispatch guard
// (runtime-rpc-websocket-dispatch.ts:76-86); this set is for runtime/desktop/CLI.
// The runtime exposes a `getMobilePairingRpcAccessors()` seam that the main process wires up to
// the live RPC server (so handlers can mint offers / manage devices without back-references).
import { defineMethod } from '../core'
import {
  MobileGetPairingQrParamsSchema,
  MobileGetRuntimePairingUrlParamsSchema,
  MobileRevokeDeviceParamsSchema
} from '../../../../shared/mobile-pairing-rpc-contract'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../../network-exposure-guidance'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type {
  MobileHostMode,
  MobileHostStatus,
  MobileHostStatusResult,
  MobileListDevicesResult,
  MobileNetworkInterfacesResult,
  MobilePairingQrResult,
  MobileRevokeDeviceResult,
  MobileRuntimePairingUrlResult
} from '../../../../shared/mobile-pairing-rpc-contract'
import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

// Why: scope check defends against accidental future dispatch loosening; the dispatcher already
// rejects `mobile.*` for phone-scope tokens, but the handlers double-check on device-touching methods.
function ensureRuntimeScope(ctx: { clientKind?: 'mobile' | 'runtime' }): void {
  if (ctx.clientKind === 'mobile') {
    throw Object.assign(new Error('mobile_scope_denied'), { code: 'forbidden' })
  }
}

export type MobilePairingRpcAccessors = {
  getWebSocketEndpoint(): string | null
  getPairingNetworkInterfaces(): Promise<
    { name: string; address: string; family: 'IPv4' | 'IPv6' }[]
  >
  getDefaultPairingAddress(): Promise<string | null>
  createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
    name?: string
  }): Promise<
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        connectionMode: 'local-only' | 'automatic' | null
      }
    | {
        available: false
        reason: string
        guidance: string
        relayFailure?: unknown
      }
  >
  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: 'mobile' | 'runtime'
    reach?: RuntimePairingReach
  }):
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
      }
    | { available: false; reason: string; guidance: string }
  getDeviceRegistry(): {
    listDevices(): readonly {
      deviceId: string
      name: string
      pairedAt: number
      lastSeenAt: number
      scope: 'mobile' | 'runtime'
    }[]
  } | null
  revokeMobileDevice(deviceId: string): Promise<boolean>
  // Why: STA-2370 widening seam; absent on hosts wired before it existed → handler no-ops.
  ensureNetworkExposure?(): Promise<void>
  isDesktopRelayProviderAttached(): boolean
  encodePairingQr(
    pairingUrl: string
  ): Promise<
    { ok: true; qrDataUrl: string; qrSize: number } | { ok: false; reason: 'encoding_failed' }
  >
}

// Why: derives the host mode without a dedicated accessor — the runtime's own getStatus already
// reports `desktopWindowStatus: 'available'` only when a live renderer is attached, so 'desktop' iff
// 'available', otherwise 'serve'.
function deriveHostMode(status: { desktopWindowStatus?: string | null }): MobileHostMode {
  return status.desktopWindowStatus === 'available' ? 'desktop' : 'serve'
}

export const MOBILE_PAIRING_METHODS = [
  defineMethod({
    name: 'mobile.hostStatus',
    params: null,
    handler: (_params, ctx): MobileHostStatusResult => {
      const status = ctx.runtime.getStatus()
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      const relayAvailable = accessors
        ? accessors.isDesktopRelayProviderAttached()
        : Boolean(status.relayAvailable)
      const webSocketEndpoint = accessors
        ? accessors.getWebSocketEndpoint()
        : (status.webSocketEndpoint ?? null)
      const result: MobileHostStatus = {
        desktopWindowStatus: status.desktopWindowStatus ?? null,
        hostMode: status.hostMode ?? deriveHostMode(status),
        relayAvailable,
        webSocketEndpoint
      }
      return result
    }
  }),

  defineMethod({
    name: 'mobile.listNetworkInterfaces',
    params: null,
    handler: async (_params, ctx): Promise<MobileNetworkInterfacesResult> => {
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      if (!accessors) {
        return { interfaces: [] }
      }
      const interfaces = await accessors.getPairingNetworkInterfaces()
      return { interfaces }
    }
  }),

  defineMethod({
    name: 'mobile.getPairingQR',
    params: MobileGetPairingQrParamsSchema,
    handler: async (params, ctx): Promise<MobilePairingQrResult> => {
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      if (!accessors) {
        return {
          available: false,
          reason: 'rpc_accessors_unavailable',
          guidance: 'Mobile pairing RPC is not wired on this host.'
        }
      }
      // Why: mirrors the IPC path — local-only with no usable interface must fail closed before the
      // offer mints; Relay can fall back to loopback but LAN-only has nothing to fall back on.
      const ip = params?.address ?? (await accessors.getDefaultPairingAddress())
      if (!ip && params?.connectionMode === 'local-only') {
        return {
          available: false,
          reason: 'invalid_advertised_endpoint',
          guidance:
            'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
        }
      }
      const result = await accessors.createMobilePairingOffer({
        address: ip,
        connectionMode: params?.connectionMode,
        rotate: params?.rotate
      })
      if (!result.available) {
        return {
          available: false,
          reason: result.reason,
          guidance: result.guidance
        }
      }
      const qr = await accessors.encodePairingQr(result.pairingUrl)
      // Why: with no advertised IP the offer's endpoint is the loopback fallback (the scanning phone,
      // never this host); surface null so the UI omits it instead of printing an unreachable address.
      return {
        available: true,
        qrDataUrl: qr.ok ? qr.qrDataUrl : null,
        qrSize: qr.ok ? qr.qrSize : null,
        pairingUrl: result.pairingUrl,
        endpoint: ip ? result.endpoint : null,
        deviceId: result.deviceId,
        connectionMode: result.connectionMode
      }
    }
  }),

  defineMethod({
    name: 'mobile.listDevices',
    params: null,
    handler: (_params, ctx): MobileListDevicesResult => {
      // Why: defence-in-depth — phone-scope callers are already rejected at the dispatcher,
      // but device-touching handlers enforce scope independently.
      ensureRuntimeScope(ctx)
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      const registry = accessors?.getDeviceRegistry()
      if (!registry) {
        return { devices: [] }
      }
      // Why: mirrors the IPC filter — pending credentials with lastSeenAt === 0 were minted by
      // QR generation but never scanned, so they are not really paired.
      return {
        devices: registry
          .listDevices()
          .filter((d) => d.scope === 'mobile' && d.lastSeenAt > 0)
          .map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            pairedAt: d.pairedAt,
            lastSeenAt: d.lastSeenAt
          }))
      }
    }
  }),

  defineMethod({
    name: 'mobile.revokeDevice',
    params: MobileRevokeDeviceParamsSchema,
    handler: async (params, ctx): Promise<MobileRevokeDeviceResult> => {
      ensureRuntimeScope(ctx)
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      if (!accessors) {
        return { revoked: false }
      }
      return { revoked: await accessors.revokeMobileDevice(params.deviceId) }
    }
  }),

  defineMethod({
    name: 'mobile.getRuntimePairingUrl',
    params: MobileGetRuntimePairingUrlParamsSchema,
    handler: async (params, ctx): Promise<MobileRuntimePairingUrlResult> => {
      const accessors = ctx.runtime.getMobilePairingRpcAccessors()
      if (!accessors) {
        return { available: false, reason: 'rpc_accessors_unavailable' }
      }
      const ip = params?.address ?? (await accessors.getDefaultPairingAddress())
      if (!ip) {
        return { available: false }
      }
      // Why: STA-2370 — a LAN offer for a loopback-only listener is a dead link; mirror the IPC path.
      if ((params?.reach ?? 'network') !== 'this-computer') {
        try {
          // Why: absent on older hosts → no-op; the offer is still minted (mixed-version callers).
          await accessors.ensureNetworkExposure?.()
        } catch {
          return {
            available: false,
            reason: 'network_exposure_failed',
            guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
          }
        }
      }
      const offer = accessors.createPairingOffer({
        address: ip,
        rotate: params?.rotate,
        scope: 'runtime',
        reach: params?.reach ?? 'network'
      })
      if (!offer.available) {
        return { available: false, reason: offer.reason, guidance: offer.guidance }
      }
      return {
        available: true,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl ?? '',
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  })
]
