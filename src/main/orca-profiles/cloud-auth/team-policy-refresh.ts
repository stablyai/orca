import type { OrcaAccountService } from '../orca-account-service'
import {
  getActiveTeamCapabilities,
  onTeamCapabilitiesInvalidated
} from './active-team-capabilities'

const FIRST_REFRESH_MS = 15_000
const TEAM_REFRESH_INTERVAL_MS = 15 * 60_000

export function scheduleTeamPolicyRefresh(account: OrcaAccountService): () => void {
  let stopped = false
  let refreshing = false
  let hasRefreshed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (!getActiveTeamCapabilities()) {
      clearTimeout(timer)
      timer = undefined
    } else if (!stopped && !refreshing && !timer) {
      timer = setTimeout(run, hasRefreshed ? TEAM_REFRESH_INTERVAL_MS : FIRST_REFRESH_MS)
      timer.unref?.()
    }
  }
  const refresh = async (): Promise<void> => {
    refreshing = true
    try {
      if (getActiveTeamCapabilities()) {
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
