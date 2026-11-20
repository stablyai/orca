// What a call came to, in the words of its automation's run history; kept on this host alone.
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  UNREADABLE_ANSWER,
  type ConnectorFailure
} from '../connector-cloud/connector-cloud-request'
import { connectorRetryDelayMs } from '../connector-cloud/connector-outbox'
import type { LedgerCall } from './webhook-host-ledger'

// Every host retries every pending call, so a cloud incident must thin out to this.
const WEBHOOK_RETRY_MAX_MS = 10 * 60_000

/** The connector's own backoff, growing to 10 minutes, and never sooner than the cloud's Retry-After. */
export function webhookRetryDelayMs(
  failures: number,
  failure: ConnectorFailure | null,
  random: () => number = Math.random
): number {
  return connectorRetryDelayMs(failures, failure ?? UNREADABLE_ANSWER, random, WEBHOOK_RETRY_MAX_MS)
}

const SETTLED: ReadonlySet<LedgerCall['state']> = new Set([
  'cancelled',
  'refused',
  'missed',
  'unavailable',
  'completed',
  'failed',
  'unverifiable'
])

export function isSettledWebhookCall(call: Pick<LedgerCall, 'state'>): boolean {
  return SETTLED.has(call.state)
}

export type WebhookCallOutcome = Pick<LedgerCall, 'state'> &
  Partial<Pick<LedgerCall, 'runId' | 'reason' | 'retryAt'>>

/** A run's final status in the words of its call; null while it runs. */
export function settledRunOutcome(run: AutomationRun): WebhookCallOutcome | null {
  const reason = run.error ?? undefined
  switch (run.status) {
    case 'completed':
      return { state: 'completed', runId: run.id }
    case 'dispatch_failed':
      return { state: 'failed', runId: run.id, reason }
    case 'skipped_missed':
      return { state: 'missed', runId: run.id }
    case 'skipped_unavailable':
    case 'skipped_precheck':
    case 'skipped_needs_interactive_auth':
      return { state: 'unavailable', runId: run.id, reason }
    case 'pending':
    case 'dispatching':
    case 'dispatched':
      return null
  }
}
