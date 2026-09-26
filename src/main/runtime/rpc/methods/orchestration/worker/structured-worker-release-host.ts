import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/**
 * The structured host a worker release reads, installed and with its restart leases settled.
 *
 * Observation and archive capture both read the structured host, and after a restart nothing has
 * installed it yet — the startup recovery reconciler runs exactly this path. Installing it here is
 * what lets the release see the session instead of reporting it unreadable. Startup no longer
 * reconciles ahead of this pass either, and an unreconciled worker that ended with the previous app
 * run still reads as live, so the release waits for that reconcile too.
 *
 * NOT yet handled, and deliberately follow-up: rebinding a restarted runtime to a structured
 * worker's hold and redrive subscription. Until that exists, a worker that survives a restart
 * keeps no hold, so its child is evictable and its parked mail waits for the next arrival rather
 * than a settle edge.
 */
export async function prepareStructuredHostForWorkerRelease(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  dispatchId: string
): Promise<void> {
  await runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => {
    console.warn('[orchestration] structured host install failed before release', dispatchId, error)
  })
  await getStructuredAgentSessionHost()
    ?.reconcileRestartLeases()
    .catch((error: unknown) => {
      console.warn(
        '[orchestration] structured lease reconcile failed before release',
        dispatchId,
        error
      )
    })
}
