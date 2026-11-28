// What a usage-limited Antigravity chat's hold needs about agy's saved accounts: the one a start
// would launch on now, its name, and word when the selection moves.

import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { AGY_HOST_SELECTION } from './agy-account-selection'

const onHostAgy = (record: AgentSessionRecord): boolean =>
  record.provider === 'antigravity' && record.location.wslDistro === null

export const AGY_USAGE_LIMIT_ACCOUNTS = {
  launchAccountId: (record: AgentSessionRecord): string | undefined => {
    if (!onHostAgy(record)) {
      return undefined
    }
    if (AGY_HOST_SELECTION.current() === null) {
      // Nothing read the saved accounts since Orca started; the next sweep pass has them.
      void AGY_HOST_SELECTION.atLaunch()
    }
    // None while a launch is known to fail to move there: releasing would hit the same limit.
    return AGY_HOST_SELECTION.target() || undefined
  },
  accountLabel: (provider: string, accountId: string): string | undefined =>
    provider === 'antigravity' ? (AGY_HOST_SELECTION.email(accountId) ?? undefined) : undefined,
  subscribeAccounts: (changed: () => void): (() => void) =>
    AGY_HOST_SELECTION.onChanged((committed) => {
      if (committed()) {
        changed()
      }
    }),
  /** Part of the attribution witness: a new selection makes every agy hold attribute again. */
  witness: (provider: string): string =>
    provider === 'antigravity' ? `:${AGY_HOST_SELECTION.target() ?? ''}` : ''
}
