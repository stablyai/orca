import type { OrcaAccountService } from '../orca-account-service'
import {
  getActivePolicyRefreshState,
  onTeamCapabilitiesInvalidated
} from './active-team-capabilities'

const FIRST_REFRESH_MS = 15_000
const TEAM_REFRESH_INTERVAL_MS = 15 * 60_000
const DISCOVERY_INTERVAL_MS = 60 * 60_000

export function scheduleTeamPolicyRefresh(
  account: Pick<OrcaAccountService, 'refreshAuth'>
): () => void {
  let stopped = false
  let refreshing = false
  let hasRefreshed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduledDelay: number | undefined
  const schedule = (): void => {
    const state = getActivePolicyRefreshState()
    const delay =
      !state || stopped
        ? undefined
        : !hasRefreshed && state !== 'personal'
          ? FIRST_REFRESH_MS
          : state === 'governed'
            ? TEAM_REFRESH_INTERVAL_MS
            : DISCOVERY_INTERVAL_MS
    if (timer && scheduledDelay !== delay) {
      clearTimeout(timer)
      timer = undefined
    }
    if (delay !== undefined && !refreshing && !timer) {
      scheduledDelay = delay
      timer = setTimeout(run, delay)
      timer.unref?.()
    }
  }
  const refresh = async (): Promise<void> => {
    refreshing = true
    try {
      if (!stopped && getActivePolicyRefreshState()) {
        hasRefreshed = true
        await account.refreshAuth({ notifyUnchanged: false })
      }
    } finally {
      refreshing = false
      schedule()
    }
  }
  const run = (): void => {
    timer = undefined
    void refresh().catch((error) => console.warn('[orca-account] Team refresh failed:', error))
  }
  const unsubscribe = onTeamCapabilitiesInvalidated(schedule)
  schedule()
  return () => {
    stopped = true
    unsubscribe()
    clearTimeout(timer)
  }
}
