import { parsePairingCode } from '../../shared/pairing'
import type { PeerClientStatus, PeerClientStatusWithHost } from '../../shared/peer-client-status'
import { PeerClientService, type PeerClientConnectResult } from './peer-client-service'

export type PeerClientManagerConnectResult =
  | { ok: true; hostId: string }
  | { ok: false; reason: string }

export type PeerClientManagerOptions = {
  createService?: () => PeerClientService
}

// Why: hostId = pairing offer's publicKeyB64, the host's per-install E2EE
// identity — stable across DHCP-assigned endpoint changes, unlike endpoint.
export class PeerClientManager {
  private readonly services = new Map<string, PeerClientService>()
  private readonly unsubscribers = new Map<string, () => void>()
  private readonly statusListeners = new Set<(hostId: string, status: PeerClientStatus) => void>()
  private readonly createService: () => PeerClientService

  constructor(options: PeerClientManagerOptions = {}) {
    this.createService = options.createService ?? (() => new PeerClientService())
  }

  connect(pairingCode: string, displayName?: string): PeerClientManagerConnectResult {
    const offer = parsePairingCode(pairingCode)
    if (!offer) {
      return { ok: false, reason: 'invalid_pairing_code' }
    }
    if (offer.scope !== 'peer') {
      return { ok: false, reason: 'not_a_peer_pairing_code' }
    }
    const hostId = offer.publicKeyB64
    const service = this.getOrCreateService(hostId)
    const result: PeerClientConnectResult = service.connect(pairingCode, displayName)
    return result.ok ? { ok: true, hostId } : result
  }

  private getOrCreateService(hostId: string): PeerClientService {
    const existing = this.services.get(hostId)
    if (existing) {
      return existing
    }
    const service = this.createService()
    this.services.set(hostId, service)
    this.unsubscribers.set(
      hostId,
      service.onStatusChange((status) => {
        for (const listener of this.statusListeners) {
          listener(hostId, status)
        }
      })
    )
    return service
  }

  // Why: 'closed' (including explicit disconnect) latches the instance in
  // the map rather than removing it, so a later connect() to the same host
  // reuses it instead of dropping in-flight state onto a fresh instance.
  disconnect(hostId: string): void {
    this.services.get(hostId)?.disconnect()
  }

  disconnectAll(): void {
    for (const service of this.services.values()) {
      service.disconnect()
    }
  }

  getService(hostId: string): PeerClientService | undefined {
    return this.services.get(hostId)
  }

  getStatuses(): PeerClientStatusWithHost[] {
    return [...this.services.entries()].map(([hostId, service]) => ({
      hostId,
      ...service.getStatus()
    }))
  }

  onStatusChange(listener: (hostId: string, status: PeerClientStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  // Why: only on app shutdown — mid-session cleanup goes through disconnect,
  // which keeps the instance around for reconnect.
  destroy(): void {
    for (const unsubscribe of this.unsubscribers.values()) {
      unsubscribe()
    }
    for (const service of this.services.values()) {
      service.destroy()
    }
    this.services.clear()
    this.unsubscribers.clear()
    this.statusListeners.clear()
  }
}

export function hostIdForPairingCode(code: string): string | null {
  return parsePairingCode(code)?.publicKeyB64 ?? null
}

// Why: single read-path migration point for the legacy single-slot field —
// callers pass both settings fields and get the array shape back.
export function readSavedPeerPairings(
  savedPairings: string[] | undefined,
  legacySingleCode: string | undefined
): string[] {
  const result = savedPairings ? [...savedPairings] : []
  if (!legacySingleCode) {
    return result
  }
  const legacyHostId = hostIdForPairingCode(legacySingleCode)
  // Why: unparsable hostId can't be deduped against other unparsable entries — always append instead of comparing null === null.
  const alreadyPresent =
    legacyHostId !== null && result.some((code) => hostIdForPairingCode(code) === legacyHostId)
  return alreadyPresent ? result : [...result, legacySingleCode]
}

// Why: replaces the existing entry for the same hostId (endpoint may have
// changed) instead of accumulating stale codes for one host.
export function upsertSavedPeerPairing(existing: string[], newCode: string): string[] {
  const newHostId = hostIdForPairingCode(newCode)
  const withoutSameHost = newHostId
    ? existing.filter((code) => hostIdForPairingCode(code) !== newHostId)
    : existing
  return [...withoutSameHost, newCode]
}
