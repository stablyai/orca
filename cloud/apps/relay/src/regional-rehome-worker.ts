import { IdleRegionalRehomeResponseSchema } from '@orca-cloud/relay-contract'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'
import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'
import { jitteredSweepIntervalMs } from './relay-sweep-schedule.js'

type RegionalRehomeWorkerOptions = {
  fetch?: typeof fetch
  identityToken?: (audience: string) => Promise<string>
  now?: () => number
  intervalMs?: number
  requestTimeoutMs?: number
  random?: () => number
  safetySnapshot?: () => RegionalRehomeSafetySnapshot
}

export type RegionalRehomeWorker = {
  run: () => Promise<void>
  stop: () => void
}

export function startRegionalRehomeWorker(
  config: RelayConfig,
  assignments: RelayAssignmentStore,
  options: RegionalRehomeWorkerOptions = {}
): RegionalRehomeWorker | null {
  if (
    config.role !== 'director' ||
    !config.rehomeAudience ||
    !config.rehomeDirectorServiceAccount ||
    !options.safetySnapshot
  ) {
    return null
  }
  const audience = config.rehomeAudience
  const safetySnapshot = options.safetySnapshot
  const fetchImpl = options.fetch ?? fetch
  const tokenProvider =
    options.identityToken ??
    ((audience: string) => googleMetadataIdentityToken(audience, fetchImpl))
  let stopped = false
  let inFlight = false
  const run = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const candidates = await assignments.selectIdleRegionalRehomeCandidates(safetySnapshot())
      if (candidates.length === 0) return
      const token = await tokenProvider(audience)
      for (const candidate of candidates) {
        if (stopped) return
        const { sourceCellUrl, ...request } = candidate
        try {
          const response = await fetchImpl(new URL('/v1/admin/host-idle-rehome', sourceCellUrl), {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              ...request,
              cohortPercent: config.regionCorrectionCohortPercent ?? 0,
              directorSafety: safetySnapshot()
            }),
            signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000)
          })
          if (!response.ok) throw new Error(`regional_rehome_source_${response.status}`)
          const body = IdleRegionalRehomeResponseSchema.parse(await response.json())
          if (body.outcome === 'committed') {
            console.warn(
              JSON.stringify({
                event: 'orca_relay_idle_rehome_committed',
                sourceCellId: candidate.sourceCellId,
                targetCellId: candidate.targetCellId
              })
            )
            return
          }
        } catch (error) {
          // The source may have committed; its durable outcome owns recovery.
          console.warn(
            JSON.stringify({
              event: 'orca_relay_idle_rehome_request_failed',
              reason: error instanceof Error ? error.message : 'unknown'
            })
          )
        }
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'orca_relay_regional_rehome_poll_failed',
          reason: error instanceof Error ? error.message : 'unknown'
        })
      )
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(
    () => void run(),
    options.intervalMs ?? jitteredSweepIntervalMs(1_000, options.random)
  )
  timer.unref()
  void run()
  return {
    run,
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
