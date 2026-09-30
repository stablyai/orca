import { join } from 'node:path'
import type { RuntimeRpcPairing } from '../runtime/runtime-rpc/runtime-rpc-pairing'
import { writeSecureJsonFile } from '../../shared/secure-file'

/**
 * Operator hook: `kill -USR2 <orcad>` mints a fresh runtime pairing offer on the running server
 * and writes it to `<data-root>/pairing-offer.json` (0600). Rotating invalidates any unused
 * offer, so a possibly leaked link dies without restarting orcad and dropping connected clients.
 *
 * Why a signal and not an RPC method: only this OS account (or root) can signal orcad, which is
 * the same authority that already reads the data root. An RPC method would let any paired device
 * mint more devices.
 */
export const ORCAD_PAIRING_OFFER_FILENAME = 'pairing-offer.json'
export const ORCAD_PAIRING_ROTATION_SIGNAL = 'SIGUSR2'

type PairingOfferSource = Pick<RuntimeRpcPairing, 'createPairingOffer'>

type SignalTarget = {
  on(signal: typeof ORCAD_PAIRING_ROTATION_SIGNAL, listener: () => void): unknown
  off(signal: typeof ORCAD_PAIRING_ROTATION_SIGNAL, listener: () => void): unknown
}

// Why accepted: a device still mid-handshake counts as unused, so rotation drops its offer and it must
// scan the new one; the handshake fails cleanly and nothing is exposed.
export function rotateOrcadPairingOffer(args: {
  rpc: PairingOfferSource
  userDataPath: string
  pairingAddress?: string
  now?: () => Date
  write?: (path: string, value: unknown) => boolean
  log?: (line: string) => void
}): boolean {
  const now = args.now ?? (() => new Date())
  const write = args.write ?? writeSecureJsonFile
  const log = args.log ?? ((line: string) => console.error(line))
  const path = join(args.userDataPath, ORCAD_PAIRING_OFFER_FILENAME)
  const offer = args.rpc.createPairingOffer({
    address: args.pairingAddress,
    name: `CLI ${now().toLocaleDateString()}`,
    scope: 'runtime',
    rotate: true
  })
  const record = offer.available
    ? {
        type: 'orca_pairing_offer',
        available: true,
        createdAt: now().toISOString(),
        deviceId: offer.deviceId,
        endpoint: offer.endpoint,
        url: offer.pairingUrl
      }
    : {
        type: 'orca_pairing_offer',
        available: false,
        reason: offer.reason,
        guidance: offer.guidance
      }
  const secured = write(path, record)
  // Never the URL: it is a bearer credential.
  log(
    offer.available
      ? `[orcad] pairing offer rotated (device ${offer.deviceId}); written to ${path}`
      : `[orcad] pairing offer unavailable (${offer.reason})`
  )
  if (!secured) {
    log(`[orcad] could not restrict permissions on ${path}; delete it after use`)
  }
  return offer.available
}

/** Installs the SIGUSR2 hook; returns an uninstaller. A no-op where the signal does not exist. */
export function installOrcadPairingRotation(args: {
  rpc: PairingOfferSource
  userDataPath: string
  pairingAddress?: string
  platform?: NodeJS.Platform
  target?: SignalTarget
  write?: (path: string, value: unknown) => boolean
  log?: (line: string) => void
}): () => void {
  if ((args.platform ?? process.platform) === 'win32') {
    return () => {}
  }
  const target = args.target ?? process
  const listener = (): void => {
    try {
      rotateOrcadPairingOffer(args)
    } catch (error) {
      // Why swallow: an operator hook must never take the server down.
      ;(args.log ?? ((line: string) => console.error(line)))(
        `[orcad] pairing offer rotation failed: ${String(error)}`
      )
    }
  }
  target.on(ORCAD_PAIRING_ROTATION_SIGNAL, listener)
  return () => target.off(ORCAD_PAIRING_ROTATION_SIGNAL, listener)
}
