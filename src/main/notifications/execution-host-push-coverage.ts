import { z } from 'zod'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { NOTIFICATIONS_PUSH_COVERAGE_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/mobile-runtime-capabilities'
import type { ExecutionHostPushCoverage } from '../runtime/push/push-burst-slots'
import { listCapableSharedControlSockets } from './desktop-presence-reporter'

// The alert waits on this answer; a slow host costs a duplicate, never the alert.
const PUSH_COVERAGE_TIMEOUT_MS = 2_000

const PushCoverageResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({ coveredTokenDigests: z.array(z.string()) })
})

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
  },
  tell: (executionHost, report) => {
    void report
      .then(async (request) => {
        const target = request.tokenDigests.length ? executionHostSocket(executionHost) : undefined
        await target?.request('notifications.recordMirrorPush', request, PUSH_COVERAGE_TIMEOUT_MS)
      })
      .catch((error: unknown) => {
        // Unheard, the host may push its own copy too: a duplicate, never a lost alert.
        console.warn('[push] Could not tell the execution host which phones were pushed:', error)
      })
  }
}
