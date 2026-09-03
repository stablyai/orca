import { z } from 'zod'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'
import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'

type RegionalRehomeWorkerOptions = {
  fetch?: typeof fetch
  identityToken?: (audience: string) => Promise<string>
  now?: () => number
  intervalMs?: number
  requestTimeoutMs?: number
  safetySnapshot?: () => RegionalRehomeSafetySnapshot
}

export type RegionalRehomeWorker = {
  run: () => Promise<void>
  stop: () => void
}

const RegionalHostDrainResponseSchema = z
  .object({
    v: z.literal(1),
    outcome: z.enum(['accepted', 'already-accepted', 'host-not-connected'])
  })
  .strict()

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
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? fetch
  const tokenProvider =
    options.identityToken ??
    ((audience: string) => googleMetadataIdentityToken(audience, fetchImpl))
  let stopped = false
  let inFlight = false
  const run = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    let attemptId: string | null = null
    try {
      const processSafety = safetySnapshot()
      const attempt = await assignments.claimRegionalRehome(processSafety)
      if (!attempt) return
      attemptId = attempt.attemptId
      const token = await tokenProvider(audience)
      const response = await fetchImpl(
        new URL('/v1/admin/host-drain', attempt.sourceCellUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            v: 1,
            attemptId: attempt.attemptId,
            userId: attempt.userId,
            relayHostId: attempt.relayHostId,
            sourceCellId: attempt.sourceCellId,
            sourceCellIncarnation: attempt.sourceCellIncarnation,
            sourceAssignmentEpoch: attempt.previousEpoch,
            graceMs: attempt.drainGraceMs
          }),
          signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000)
        }
      )
      if (!response.ok) throw new Error(`regional_rehome_source_${response.status}`)
      const body = RegionalHostDrainResponseSchema.safeParse(await response.json())
      if (!body.success) throw new Error('regional_rehome_source_invalid_response')
      await assignments.recordRegionalRehomeDrainReceipt(
        attempt.attemptId,
        body.data.outcome
      )
      console.warn(
        JSON.stringify({
          event: 'orca_relay_regional_rehome_dispatched',
          sourceCellId: attempt.sourceCellId,
          targetCellId: attempt.targetCellId,
          outcome: body.data.outcome,
          sendAttempts: attempt.sendAttempts
        })
      )
    } catch (error) {
      await (attemptId
        ? assignments.recordRegionalRehomeDispatchFailure(attemptId)
        : assignments.recordRegionalRehomeWorkerFailure()
      ).catch(() => undefined)
      console.warn(
        JSON.stringify({
          event: 'orca_relay_regional_rehome_dispatch_failed',
          reason: error instanceof Error ? error.message : 'unknown'
        })
      )
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => void run(), options.intervalMs ?? 1_000)
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
