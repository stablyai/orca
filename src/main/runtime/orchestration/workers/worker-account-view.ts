import { acquiredAgentSessionAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

/** The account a worker's chat was actually launched under, as the host observed it. */
export type WorkerAccountView =
  | { provider: string; route: 'managed'; accountId: string }
  | { provider: string; route: 'system' }

/**
 * Null when the host never observed a launch, or when the observation no longer matches the
 * record (another host, another session, a stale fence). Home and config paths stay out: they
 * are local filesystem details, and the managed account id or the system route is what a
 * coordinator needs to attribute the worker's usage.
 */
export function workerAccountView(
  record: AgentSessionRecord | null | undefined,
  hostId: string | undefined
): WorkerAccountView | null {
  if (!record) {
    return null
  }
  const acquired = acquiredAgentSessionAccount(record, hostId)
  if (!acquired) {
    return null
  }
  return acquired.recipe.route === 'managed'
    ? { provider: record.provider, route: 'managed', accountId: acquired.recipe.accountId }
    : { provider: record.provider, route: 'system' }
}
