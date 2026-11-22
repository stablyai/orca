import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

/** The polled usage of the account a chat continues on, as the host attributes it. */
export type UsageLimitAccountUsage = {
  /** Attributed home and account identity; state kept for another account never applies. */
  key: string
  /** The reading now, or null once it no longer describes this account. */
  read: () => ProviderRateLimits | null
  /** A non-forced fetch that keeps the poller's Retry-After and failure backoff; with
   *  `notWithinMs`, at most one per account that often, however many chats ask. False when the
   *  service started none. */
  refresh: (notWithinMs?: number) => boolean
}

/** Where a launch would bill: a hold never outlives the scope it was taken in. */
export type UsageLimitAccountScope = {
  /** Canonical launch home plus billing kind. */
  scope: string
  /** The reading that describes this scope's account; absent when none does. */
  account?: UsageLimitAccountUsage
  /** Asks for a first reading while the provider has none, like `refresh`; a due send waits for it
   *  briefly. */
  bootstrap?: (notWithinMs?: number) => boolean
}

/** What attributing a chat to an account reads from the host. */
export type UsageLimitAccountAttributionHost = Pick<
  StructuredAgentSessionHostDeps,
  'launchAccountHome' | 'usageLimitAutoContinue'
> & { store: Pick<AgentSessionRecordStore, 'getRecord'> }

/** Changes whenever a source the provider's attribution reads changes. */
export function liveWitness(
  host: UsageLimitAccountAttributionHost,
  provider: AgentSessionRecord['provider']
): string | undefined {
  return host.usageLimitAutoContinue?.accountWitness?.(provider)
}
