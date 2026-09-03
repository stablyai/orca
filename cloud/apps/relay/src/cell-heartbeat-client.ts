import { randomUUID } from 'node:crypto'
import type { RelayConfig } from './config.js'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'
import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'

type ConnectionCounts = {
  totalConnections: number
  inFlightConnections: number
  reservedConnectionUnits: number
  enforcedConnectionUnits: number
  inclusionWatermark?: number
}

type HeartbeatClientOptions = {
  ready: () => Promise<boolean>
  observedRequests: () => number
  connectionCounts: () => ConnectionCounts
  regionalRehomeSafety?: () => RegionalRehomeSafetySnapshot
  fetch?: typeof fetch
  identityToken?: (audience: string) => Promise<string>
  now?: () => number
  incarnation?: string
  intervalMs?: number
}

export type CellHeartbeatClient = { stop: () => void; send: () => Promise<void> }

export function startCellHeartbeat(
  config: RelayConfig,
  options: HeartbeatClientOptions
): CellHeartbeatClient | null {
  if (config.role !== 'cell' || !config.directorUrl || !config.heartbeatAudience) return null
  const fetchImpl = options.fetch ?? fetch
  const tokenProvider =
    options.identityToken ?? ((audience) => googleMetadataIdentityToken(audience, fetchImpl))
  const startedAt = (options.now ?? Date.now)()
  const cellIncarnation = options.incarnation ?? randomUUID()
  let stopped = false
  let inFlight = false

  const send = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const [token, ready] = await Promise.all([
        tokenProvider(config.heartbeatAudience!),
        options.ready()
      ])
      const connectionCounts =
        config.connectionHardCap === undefined ? null : options.connectionCounts()
      const response = await fetchImpl(
        new URL('/v1/admin/cell-heartbeat', config.directorUrl).toString(),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            v: 1,
            cellId: config.cellId,
            cellUrl: config.cellUrl,
            region: config.region ?? 'us-central1',
            cellIncarnation,
            startedAt,
            ready,
            observedRequests: options.observedRequests(),
            ...(config.connectionHardCap === undefined
              ? {}
              : {
                  totalConnections: connectionCounts!.totalConnections,
                  inFlightConnections: connectionCounts!.inFlightConnections,
                  reservedConnectionUnits: connectionCounts!.reservedConnectionUnits,
                  enforcedConnectionUnits: connectionCounts!.enforcedConnectionUnits,
                  connectionInclusionWatermark:
                    connectionCounts!.inclusionWatermark,
                  connectionHardCap: config.connectionHardCap,
                  connectionUnobservedBound: config.connectionUnobservedBound
                })
          }),
          signal: AbortSignal.timeout(10_000)
        }
      )
      if (!response.ok) throw new Error(`director_heartbeat_${response.status}`)
      if (options.regionalRehomeSafety) {
        const statusResponse = await fetchImpl(
          new URL('/v1/admin/cell-rehome-status', config.directorUrl).toString(),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              v: 1,
              cellId: config.cellId,
              cellIncarnation,
              regionalRehomeProtocol:
                config.rehomeAudience && config.rehomeDirectorServiceAccount ? 1 : 0,
              safety: options.regionalRehomeSafety()
            }),
            signal: AbortSignal.timeout(10_000)
          }
        )
        if (!statusResponse.ok && statusResponse.status !== 404) {
          throw new Error(`director_rehome_status_${statusResponse.status}`)
        }
      }
    } catch (error) {
      // A heartbeat must fail closed without ever logging its bearer token.
      console.warn('[orca-relay] cell heartbeat failed', error instanceof Error ? error.message : '')
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => void send(), options.intervalMs ?? 15_000)
  timer.unref()
  void send()
  return {
    send,
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
