import type { OrcaAccountService } from '../orca-account-service'

const FIRST_REFRESH_MS = 15_000
const TEAM_REFRESH_INTERVAL_MS = 15 * 60_000

export function scheduleTeamPolicyRefresh(account: OrcaAccountService): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const refresh = async (): Promise<void> => {
    try {
      const status = account.getAuthStatus()
      if (status.state === 'connected' && status.cloud?.activeOrgId) {
        await account.refreshAuth({ notifyUnchanged: false })
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(run, TEAM_REFRESH_INTERVAL_MS)
        timer.unref?.()
      }
    }
  }
  const run = (): void => {
    void refresh().catch((error) => console.warn('[orca-account] Team refresh failed:', error))
  }
  timer = setTimeout(run, FIRST_REFRESH_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
