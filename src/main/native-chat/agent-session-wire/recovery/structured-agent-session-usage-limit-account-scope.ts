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

/** What a chat's attribution was computed under: the sources' witness and the launch the record
 *  named. A send binds to both. */
export type UsageLimitAttributionBinding = {
  witness: string | undefined
  launchFence: number | undefined
  runtimeFence: number | undefined
}

/** What `record`'s attribution would be computed under now. */
export function attributionBinding(
  host: UsageLimitAccountAttributionHost,
  record: AgentSessionRecord | null
): UsageLimitAttributionBinding {
  return {
    witness: record ? liveWitness(host, record.provider) : undefined,
    launchFence: record?.launchedAccount?.fence,
    runtimeFence: record?.lease.runtimeFence
  }
}

/** Whether `binding` still describes `record`: same sources, same launch. */
export function attributionBindingHolds(
  host: UsageLimitAccountAttributionHost,
  record: AgentSessionRecord | null,
  binding: UsageLimitAttributionBinding | undefined
): boolean {
  const now = attributionBinding(host, record)
  return (
    binding !== undefined &&
    record !== null &&
    now.witness === binding.witness &&
    now.launchFence === binding.launchFence &&
    now.runtimeFence === binding.runtimeFence
  )
}

/** Changes whenever a source the provider's attribution reads changes. */
function liveWitness(
  host: UsageLimitAccountAttributionHost,
  provider: AgentSessionRecord['provider']
): string | undefined {
  return host.usageLimitAutoContinue?.accountWitness?.(provider)
}

export type UsageLimitAccountVerdict = {
  /** The latest reset the send waits for: the cut's, or a later one the account still shows spent. */
  resetsAt: number
  /** The account shows a spent window with no known reset; nothing is sent automatically. */
  unknownReset: boolean
  /** Due, but no reading taken since that reset has arrived yet. */
  awaitingReading: boolean
}
