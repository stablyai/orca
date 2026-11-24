import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

/** Agents copy Dispatch ids from receipts without the dispatch: prefix; point them at it. */
export function withDispatchPrefixHint(
  db: OrchestrationDb,
  to: string,
  refusal: { code: string; message: string }
): string {
  return refusal.code === 'terminal_not_found' && db.getDispatchContextById(to)
    ? `${refusal.message} Did you mean --to dispatch:${to}?`
    : refusal.message
}
