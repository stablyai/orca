import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/mobile-runtime-capabilities'
import type { ExecutionHostPushCoverage } from '../runtime/push/push-burst-slots'
import { listCapableSharedControlSockets } from './desktop-presence-reporter'

// The alert waits on this answer; a slow host costs a duplicate, never the alert.
const PUSH_COVERAGE_TIMEOUT_MS = 2_000

const PushCoverageResponseSchema = lazyZodSchema(() =>
  z.object({
    ok: z.literal(true),
    result: z.object({ coveredTokenDigests: z.array(z.string()) })
  })
)

/** Older hosts, other host kinds and unreachable ones cover nothing, so this desktop pushes as before. */
function executionHostSocket(executionHost: string) {
  const host = parseExecutionHostId(executionHost)
  return host?.kind === 'runtime'
    ? listCapableSharedControlSockets(NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY).find(
        (candidate) => candidate.environmentId === host.environmentId
      )
    : undefined
}

export const executionHostPushCoverage: ExecutionHostPushCoverage = {
  ask: async (executionHost, request) => {
    const target = executionHostSocket(executionHost)
    if (!target) {
      return new Set()
    }
    const response = PushCoverageResponseSchema.safeParse(
      await target.request('notifications.pushCoverage', request, PUSH_COVERAGE_TIMEOUT_MS)
    )
    return new Set(response.success ? response.data.result.coveredTokenDigests : [])
  }
}
