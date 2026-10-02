import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionSinkOperation } from './structured-agent-session-event-sink-queue'

/** One live activity publish. Coalesced, so a newer one replaces any still queued: at most one is
 *  ever queued, of bounded size, so it is admitted past a full queue and the newest value, a turn's
 *  closing clear included, is never lost. */
export function turnActivityOperation(
  activity: AgentSessionTurnActivity | null
): Omit<StructuredAgentSessionSinkOperation, 'sequence'> {
  return {
    bytes: Buffer.byteLength(JSON.stringify(activity), 'utf8') + 64,
    coalescingKey: 'turn-activity',
    overWatermark: true,
    run: (bound) => bound.publish(activity)
  }
}
