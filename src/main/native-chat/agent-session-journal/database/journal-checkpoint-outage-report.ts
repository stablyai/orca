import { startSpan } from '../../../observability/tracer'
import type { JournalCheckpointOutage } from './journal-checkpoint-owner'

/** One span per stretch the chat journal's writer checkpointed without its worker. */
export function reportJournalCheckpointOutage(outage: JournalCheckpointOutage): void {
  startSpan('agentSession.journal-checkpoint-outage', {
    attributes: {
      kind: 'agent-session',
      'journal_checkpoint.cause': outage.cause,
      'journal_checkpoint.outage_ms': Math.round(outage.outageMs),
      'journal_checkpoint.recovered': outage.recovered,
      'journal_checkpoint.restarts': outage.restarts,
      'journal_checkpoint.total_outage_ms': Math.round(outage.totalOutageMs)
    }
  }).end()
}
