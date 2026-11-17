import { z } from 'zod'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/mobile-runtime-capabilities'
import type { PushCoverageResolver } from '../runtime/push/push-dispatcher'
import { listCapableSharedControlSockets } from './desktop-presence-reporter'

// The alert waits on this answer; a slow host costs a duplicate, never the alert.
const PUSH_COVERAGE_TIMEOUT_MS = 2_000

const PushCoverageResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({ coveredTokenDigests: z.array(z.string()) })
})

/** Older hosts, other host kinds and unreachable ones cover nothing, so this desktop pushes as before. */
export const requestExecutionHostPushCoverage: PushCoverageResolver = async (
  executionHost,
  request
) => {
  const host = parseExecutionHostId(executionHost)
  const target =
    host?.kind === 'runtime'
      ? listCapableSharedControlSockets(NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY).find(
          (candidate) => candidate.environmentId === host.environmentId
        )
      : undefined
  if (!target) {
    return new Set()
  }
  const response = PushCoverageResponseSchema.safeParse(
    await target.request('notifications.pushCoverage', request, PUSH_COVERAGE_TIMEOUT_MS)
  )
  return new Set(response.success ? response.data.result.coveredTokenDigests : [])
}
