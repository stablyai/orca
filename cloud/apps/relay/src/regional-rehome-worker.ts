import {
  IdleRegionalRehomeResponseSchema,
  isGlobalIdleRegionalRehomeDeferral
} from '@orca-cloud/relay-contract'
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
      const outcomes: Record<string, number> = {}
      const tally = (key: string) => {
        outcomes[key] = (outcomes[key] ?? 0) + 1
      }
      let stoppedBy: string | null = null
      for (const candidate of candidates) {
        if (stopped) break
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
          tally(body.reason ? `${body.outcome}:${body.reason}` : body.outcome)
          if (body.outcome === 'committed') {
            console.warn(
              JSON.stringify({
                event: 'orca_relay_idle_rehome_committed',
                sourceCellId: candidate.sourceCellId,
                targetCellId: candidate.targetCellId
              })
            )
            stoppedBy = 'committed'
            break
          }
          // Every remaining candidate would re-read the same durable row and
          // answer the same way, so the rest of this page is wasted POSTs.
          // A source on an older image sends no reason and keeps the old walk.
          if (body.outcome === 'deferred' && isGlobalIdleRegionalRehomeDeferral(body.reason)) {
            stoppedBy = body.reason
            break
          }
        } catch (error) {
          tally('failed')
          // The source may have committed; its durable outcome owns recovery.
          console.warn(
            JSON.stringify({
              event: 'orca_relay_idle_rehome_request_failed',
              reason: error instanceof Error ? error.message : 'unknown'
            })
          )
        }
      }
      // One line per poll that dispatched: silence used to be the only signal
      // that 100+ candidates all came back deferred.
      console.warn(
        JSON.stringify({
          event: 'orca_relay_idle_rehome_dispatch_summary',
          candidates: candidates.length,
          dispatched: Object.values(outcomes).reduce((total, count) => total + count, 0),
          stoppedBy,
          outcomes
        })
      )
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
    // Match the initial ten-moves/minute budget without replanning the join every second.
    options.intervalMs ?? jitteredSweepIntervalMs(6_000, options.random)
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
